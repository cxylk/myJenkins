import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, nowIso, run } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { secrets } from '../secret-box.js';
import type { CredentialRow } from '../models.js';
import { requireAdmin } from '../auth/plugin.js';

const authType = z.enum(['https_token', 'ssh_key']);

const createSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(80),
  authType,
  username: z.string().trim().max(120).optional().nullable(),
  secret: z.string().min(1, '密钥/Token 不能为空').max(100_000),
  passphrase: z.string().max(500).optional().nullable(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  authType: authType.optional(),
  username: z.string().trim().max(120).optional().nullable(),
  secret: z.string().min(1).max(100_000).optional(),
  passphrase: z.string().max(500).optional().nullable(),
  clearPassphrase: z.boolean().optional(),
});

function credentialDto(row: CredentialRow) {
  return {
    id: row.id,
    name: row.name,
    authType: row.auth_type,
    username: row.username,
    hasSecret: true,
    hasPassphrase: Boolean(row.passphrase_enc),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateSecret(type: 'https_token' | 'ssh_key', secret: string): void {
  if (type === 'https_token') {
    if (/\s/.test(secret.trim())) throw badRequest('Token 不能包含空白字符');
    return;
  }
  if (!secret.includes('PRIVATE KEY')) {
    throw badRequest('SSH 私钥格式不正确，请粘贴完整的 PEM/OpenSSH 私钥（包含 BEGIN/END 行）');
  }
}

export async function credentialRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req) => {
    requireAdmin(req);
    const rows = all<CredentialRow>('SELECT * FROM git_credentials ORDER BY id ASC');
    return { credentials: rows.map(credentialDto) };
  });

  app.post('/', async (req, reply) => {
    requireAdmin(req);
    const body = createSchema.parse(req.body);
    if (body.authType === 'https_token' && !body.username?.trim()) {
      throw badRequest('HTTPS 凭据需要填写用户名（可以是任意占位用户名，例如 git）');
    }
    validateSecret(body.authType, body.secret);
    const now = nowIso();
    const result = run(
      `INSERT INTO git_credentials (name, auth_type, username, secret_enc, passphrase_enc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      body.name,
      body.authType,
      body.username?.trim() || null,
      secrets().encrypt(body.secret),
      body.passphrase ? secrets().encrypt(body.passphrase) : null,
      now,
      now,
    );
    const created = get<CredentialRow>('SELECT * FROM git_credentials WHERE id = ?', result.lastInsertRowid)!;
    reply.code(201);
    return { credential: credentialDto(created) };
  });

  app.patch('/:id', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const row = get<CredentialRow>('SELECT * FROM git_credentials WHERE id = ?', id);
    if (!row) throw notFound('凭据不存在');
    const body = updateSchema.parse(req.body);
    const nextType = body.authType ?? row.auth_type;
    if (body.authType && body.authType !== row.auth_type && !body.secret) {
      throw badRequest('切换凭据类型时必须重新填写密钥/Token');
    }
    if (body.secret) validateSecret(nextType, body.secret);
    if (nextType === 'https_token') {
      const username = body.username === undefined ? row.username : body.username;
      if (!username?.trim()) throw badRequest('HTTPS 凭据需要填写用户名');
    }

    const passphraseEnc =
      body.clearPassphrase === true
        ? null
        : body.passphrase !== undefined && body.passphrase !== null && body.passphrase !== ''
          ? secrets().encrypt(body.passphrase)
          : row.passphrase_enc;

    run(
      `UPDATE git_credentials SET name = ?, auth_type = ?, username = ?, secret_enc = ?, passphrase_enc = ?, updated_at = ?
       WHERE id = ?`,
      body.name ?? row.name,
      nextType,
      body.username === undefined ? row.username : body.username?.trim() || null,
      body.secret ? secrets().encrypt(body.secret) : row.secret_enc,
      passphraseEnc,
      nowIso(),
      id,
    );
    const updated = get<CredentialRow>('SELECT * FROM git_credentials WHERE id = ?', id)!;
    return { credential: credentialDto(updated) };
  });

  app.delete('/:id', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const row = get<CredentialRow>('SELECT * FROM git_credentials WHERE id = ?', id);
    if (!row) throw notFound('凭据不存在');
    const used = get<{ c: number }>('SELECT COUNT(*) AS c FROM projects WHERE credential_id = ?', id);
    if (Number(used?.c ?? 0) > 0) throw conflict('该凭据仍被项目使用，请先解除关联后再删除');
    run('DELETE FROM git_credentials WHERE id = ?', id);
    return { ok: true };
  });
}
