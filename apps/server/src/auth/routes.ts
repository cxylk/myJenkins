import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { get, nowIso, run } from '../db.js';
import { AppError, badRequest, unauthorized } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import type { UserRow } from '../models.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  destroyUserSessions,
  setSessionCookie,
  userDto,
} from './session.js';
import { currentUser } from './plugin.js';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8, '新密码至少 8 位').max(128),
});

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPT_KEYS = 5000;

function pruneAttempts(now: number): void {
  if (attempts.size < 1000) return;
  for (const [key, entry] of attempts) {
    if (entry.resetAt <= now) attempts.delete(key);
  }
  if (attempts.size <= MAX_ATTEMPT_KEYS) return;
  for (const key of attempts.keys()) {
    attempts.delete(key);
    if (attempts.size <= MAX_ATTEMPT_KEYS) break;
  }
}

function checkRateLimit(key: string): void {
  const now = Date.now();
  pruneAttempts(now);
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 5 * 60_000 });
    return;
  }
  entry.count += 1;
  if (entry.count > 5) {
    throw new AppError(429, 'TOO_MANY_ATTEMPTS', '登录失败次数过多，请 5 分钟后再试');
  }
}

function resetRateLimit(key: string): void {
  attempts.delete(key);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const key = `${req.ip}|${body.username.toLowerCase()}`;
    checkRateLimit(key);

    const user = get<UserRow>('SELECT * FROM users WHERE username = ?', body.username);
    if (!user || user.disabled) {
      throw unauthorized('用户名或密码错误');
    }
    const ok = await verifyPassword(body.password, user.password_hash);
    if (!ok) throw unauthorized('用户名或密码错误');

    resetRateLimit(key);
    const session = createSession(user.id, req.ip, req.headers['user-agent'] ?? null);
    setSessionCookie(req, reply, session.token);
    return { user: userDto(user) };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies['myj_sid'];
    if (token) destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/me', async (req) => ({ user: userDto(currentUser(req)) }));

  app.put('/password', async (req, reply) => {
    const user = currentUser(req);
    const body = changePasswordSchema.parse(req.body);
    const row = get<UserRow>('SELECT * FROM users WHERE id = ?', user.id);
    if (!row) throw unauthorized();
    if (!(await verifyPassword(body.oldPassword, row.password_hash))) {
      throw badRequest('原密码不正确');
    }
    const hash = await hashPassword(body.newPassword);
    run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, nowIso(), user.id);
    destroyUserSessions(user.id);
    const session = createSession(user.id, req.ip, req.headers['user-agent'] ?? null);
    setSessionCookie(req, reply, session.token);
    return { ok: true };
  });
}

export function loginRateLimitKey(req: FastifyRequest): string {
  return req.ip;
}
