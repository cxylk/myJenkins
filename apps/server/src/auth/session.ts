import type { FastifyReply, FastifyRequest } from 'fastify';
import { all, get, nowIso, run } from '../db.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { UserRow } from '../models.js';

export const COOKIE_NAME = 'myj_sid';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'member';
  displayName: string | null;
}

interface SessionJoinRow {
  token_hash: string;
  expires_at: string;
  last_seen_at: string;
  id: number;
  username: string;
  role: 'admin' | 'member';
  display_name: string | null;
  disabled: number;
}

export function createSession(userId: number, ip: string | null, userAgent: string | null): { token: string; expiresAt: string } {
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionDays * 86_400_000).toISOString();
  run(
    'INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    expiresAt,
    now.toISOString(),
    ip,
    userAgent ? userAgent.slice(0, 300) : null,
    now.toISOString(),
  );
  run('DELETE FROM sessions WHERE expires_at < ?', now.toISOString());
  return { token, expiresAt };
}

export function findSession(token: string): { user: AuthUser; tokenHash: string } | null {
  const tokenHash = sha256(token);
  const row = get<SessionJoinRow>(
    `SELECT s.token_hash, s.expires_at, s.last_seen_at, u.id, u.username, u.role, u.display_name, u.disabled
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    tokenHash,
  );
  if (!row) return null;
  const now = new Date();
  if (row.disabled || new Date(row.expires_at).getTime() <= now.getTime()) {
    run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
    return null;
  }
  if (now.getTime() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    const expiresAt = new Date(now.getTime() + config.sessionDays * 86_400_000).toISOString();
    run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?', now.toISOString(), expiresAt, tokenHash);
  }
  return {
    tokenHash,
    user: { id: row.id, username: row.username, role: row.role, displayName: row.display_name },
  };
}

export function destroySession(token: string): void {
  run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function destroyUserSessions(userId: number): void {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function sessionCookieOptions(req: FastifyRequest) {
  const secure = config.cookieSecure === 'auto' ? req.protocol === 'https' : config.cookieSecure;
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: config.sessionDays * 86_400,
  };
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, sessionCookieOptions(req));
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

export function userDto(user: UserRow | AuthUser) {
  const displayName = 'display_name' in user ? user.display_name : user.displayName;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: displayName ?? null,
  };
}

export function listActiveAdminIds(): number[] {
  return all<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND disabled = 0").map((r) => r.id);
}

export function countAdmins(): number {
  const row = get<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0");
  return Number(row?.c ?? 0);
}

export function nowString(): string {
  return nowIso();
}
