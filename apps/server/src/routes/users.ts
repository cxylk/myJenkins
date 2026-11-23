import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, nowIso, run } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { hashPassword } from '../lib/crypto.js';
import type { UserRow } from '../models.js';
import { countAdmins, destroyUserSessions, userDto } from '../auth/session.js';
import { requireAdmin } from '../auth/plugin.js';

const usernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{3,32}$/, '用户名需为 3-32 位字母、数字、下划线、点或短横线');

const createSchema = z.object({
  username: usernameSchema,
  password: z.string().min(8, '密码至少 8 位').max(128),
  role: z.enum(['admin', 'member']).default('member'),
  displayName: z.string().trim().max(50).optional().nullable(),
});

const updateSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  displayName: z.string().trim().max(50).optional().nullable(),
  disabled: z.boolean().optional(),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8, '密码至少 8 位').max(128),
});

interface UserListRow extends UserRow {
  project_count: number;
}

function assertNotLastAdmin(target: UserRow, action: string): void {
  if (target.role === 'admin' && target.disabled === 0 && countAdmins() <= 1) {
    throw conflict(`不能${action}最后一个启用中的管理员`);
  }
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req) => {
    requireAdmin(req);
    const rows = all<UserListRow>(
      `SELECT u.*, (SELECT COUNT(*) FROM project_members m WHERE m.user_id = u.id) AS project_count
       FROM users u ORDER BY u.id ASC`,
    );
    return {
      users: rows.map((row) => ({
        ...userDto(row),
        disabled: row.disabled === 1,
        projectCount: Number(row.project_count),
        createdAt: row.created_at,
      })),
    };
  });

  app.post('/', async (req, reply) => {
    requireAdmin(req);
    const body = createSchema.parse(req.body);
    const exists = get<{ id: number }>('SELECT id FROM users WHERE username = ?', body.username);
    if (exists) throw conflict('用户名已存在');
    const now = nowIso();
    const hash = await hashPassword(body.password);
    const result = run(
      'INSERT INTO users (username, password_hash, role, display_name, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      body.username,
      hash,
      body.role,
      body.displayName ?? null,
      now,
      now,
    );
    const created = get<UserRow>('SELECT * FROM users WHERE id = ?', result.lastInsertRowid)!;
    reply.code(201);
    return { user: { ...userDto(created), disabled: false, createdAt: created.created_at } };
  });

  app.patch('/:id', async (req) => {
    const me = requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const target = get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!target) throw notFound('用户不存在');
    const body = updateSchema.parse(req.body);

    if (id === me.id && body.disabled === true) throw badRequest('不能禁用当前登录账号');
    if (target.role === 'admin' && (body.role === 'member' || body.disabled === true)) {
      assertNotLastAdmin(target, body.disabled === true ? '禁用' : '降级');
    }

    const next = {
      role: body.role ?? target.role,
      display_name: body.displayName === undefined ? target.display_name : body.displayName,
      disabled: body.disabled === undefined ? target.disabled : body.disabled ? 1 : 0,
    };
    run(
      'UPDATE users SET role = ?, display_name = ?, disabled = ?, updated_at = ? WHERE id = ?',
      next.role,
      next.display_name,
      next.disabled,
      nowIso(),
      id,
    );
    if (next.disabled === 1 || next.role !== target.role) destroyUserSessions(id);
    const updated = get<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
    return { user: { ...userDto(updated), disabled: updated.disabled === 1, createdAt: updated.created_at } };
  });

  app.post('/:id/reset-password', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const target = get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!target) throw notFound('用户不存在');
    const body = resetPasswordSchema.parse(req.body);
    const hash = await hashPassword(body.password);
    run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, nowIso(), id);
    destroyUserSessions(id);
    return { ok: true };
  });

  app.delete('/:id', async (req) => {
    const me = requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    if (id === me.id) throw badRequest('不能删除当前登录账号');
    const target = get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!target) throw notFound('用户不存在');
    assertNotLastAdmin(target, '删除');
    run('DELETE FROM users WHERE id = ?', id);
    return { ok: true };
  });
}

