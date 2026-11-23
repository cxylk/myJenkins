import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, nowIso, run } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { secrets } from '../secret-box.js';
import type { ServerRow } from '../models.js';
import { requireAdmin } from '../auth/plugin.js';
import { connectSsh, testConnection, type SshTarget } from '../ssh.js';

const authType = z.enum(['password', 'private_key']);

const createSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(80),
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._:\-\[\]]+$/, '主机地址格式不正确（不支持空格和路径）'),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1, '用户名不能为空').max(64),
  authType,
  secret: z.string().min(1, '密码/私钥不能为空').max(100_000),
  passphrase: z.string().max(500).optional().nullable(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._:\-\[\]]+$/)
    .optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(64).optional(),
  authType: authType.optional(),
  secret: z.string().min(1).max(100_000).optional(),
  passphrase: z.string().max(500).optional().nullable(),
  clearPassphrase: z.boolean().optional(),
});

function serverDto(row: ServerRow, usedBy = 0) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type,
    fingerprint: row.host_key_fingerprint,
    trusted: Boolean(row.host_key_fingerprint),
    trustedAt: row.trusted_at,
    usedByProjects: usedBy,
    hasPassphrase: Boolean(row.passphrase_enc),
    createdAt: row.created_at,
  };
}

function toSshTarget(row: ServerRow): SshTarget {
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type,
    secret: secrets().decrypt(row.secret_enc),
    passphrase: row.passphrase_enc ? secrets().decrypt(row.passphrase_enc) : null,
    fingerprint: row.host_key_fingerprint,
  };
}

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req) => {
    requireAdmin(req);
    const rows = all<ServerRow & { used_by: number }>(
      `SELECT s.*, (SELECT COUNT(DISTINCT t.project_id) FROM project_targets t WHERE t.server_id = s.id) AS used_by
       FROM servers s ORDER BY s.id ASC`,
    );
    return { servers: rows.map((row) => serverDto(row, Number(row.used_by))) };
  });

  app.post('/', async (req, reply) => {
    requireAdmin(req);
    const body = createSchema.parse(req.body);
    if (body.authType === 'private_key' && !body.secret.includes('PRIVATE KEY')) {
      throw badRequest('SSH 私钥格式不正确，请粘贴完整的私钥内容');
    }
    const now = nowIso();
    const result = run(
      `INSERT INTO servers (name, host, port, username, auth_type, secret_enc, passphrase_enc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      body.name,
      body.host,
      body.port,
      body.username,
      body.authType,
      secrets().encrypt(body.secret),
      body.passphrase ? secrets().encrypt(body.passphrase) : null,
      now,
      now,
    );
    const created = get<ServerRow>('SELECT * FROM servers WHERE id = ?', result.lastInsertRowid)!;
    reply.code(201);
    return { server: serverDto(created) };
  });

  app.patch('/:id', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const row = get<ServerRow>('SELECT * FROM servers WHERE id = ?', id);
    if (!row) throw notFound('服务器不存在');
    const body = updateSchema.parse(req.body);
    if (body.secret && (body.authType ?? row.auth_type) === 'private_key' && !body.secret.includes('PRIVATE KEY')) {
      throw badRequest('SSH 私钥格式不正确，请粘贴完整的私钥内容');
    }
    const passphraseEnc =
      body.clearPassphrase === true
        ? null
        : body.passphrase
          ? secrets().encrypt(body.passphrase)
          : row.passphrase_enc;
    run(
      `UPDATE servers SET name = ?, host = ?, port = ?, username = ?, auth_type = ?, secret_enc = ?, passphrase_enc = ?, updated_at = ?
       WHERE id = ?`,
      body.name ?? row.name,
      body.host ?? row.host,
      body.port ?? row.port,
      body.username ?? row.username,
      body.authType ?? row.auth_type,
      body.secret ? secrets().encrypt(body.secret) : row.secret_enc,
      passphraseEnc,
      nowIso(),
      id,
    );
    const updated = get<ServerRow>('SELECT * FROM servers WHERE id = ?', id)!;
    return { server: serverDto(updated) };
  });

  app.delete('/:id', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const row = get<ServerRow>('SELECT * FROM servers WHERE id = ?', id);
    if (!row) throw notFound('服务器不存在');
    const used = get<{ c: number }>('SELECT COUNT(*) AS c FROM project_targets WHERE server_id = ?', id);
    if (Number(used?.c ?? 0) > 0) throw conflict('该服务器仍被项目使用，请先从项目中移除');
    run('DELETE FROM servers WHERE id = ?', id);
    return { ok: true };
  });

  app.post('/:id/test', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const row = get<ServerRow>('SELECT * FROM servers WHERE id = ?', id);
    if (!row) throw notFound('服务器不存在');
    const result = await testConnection(toSshTarget(row), { acceptAnyHostKey: !row.host_key_fingerprint });
    if (result.ok && result.fingerprint) {
      return {
        ...result,
        trusted: row.host_key_fingerprint === result.fingerprint,
        changed: Boolean(row.host_key_fingerprint) && row.host_key_fingerprint !== result.fingerprint,
      };
    }
    return { ...result, trusted: false };
  });

  app.post('/:id/trust', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const row = get<ServerRow>('SELECT * FROM servers WHERE id = ?', id);
    if (!row) throw notFound('服务器不存在');
    const body = z.object({ fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/) }).parse(req.body);
    const target = toSshTarget(row);
    const connected = await connectSsh(target, { acceptAnyHostKey: true });
    try {
      if (connected.fingerprint !== body.fingerprint) {
        throw new AppError(409, 'HOST_KEY_CHANGED', '服务器主机指纹与页面展示的不一致，请重新测试连接', {
          expected: body.fingerprint,
          actual: connected.fingerprint,
        });
      }
    } finally {
      connected.client.end();
    }
    run(
      'UPDATE servers SET host_key_fingerprint = ?, trusted_at = ?, updated_at = ? WHERE id = ?',
      body.fingerprint,
      nowIso(),
      nowIso(),
      id,
    );
    return { ok: true, fingerprint: body.fingerprint };
  });
}
