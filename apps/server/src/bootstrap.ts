import type { FastifyInstance } from 'fastify';
import { get, nowIso, run } from './db.js';
import { config } from './config.js';
import { hashPassword, randomToken } from './lib/crypto.js';

export async function ensureAdmin(app: FastifyInstance): Promise<void> {
  const count = Number(get<{ c: number }>('SELECT COUNT(*) AS c FROM users')?.c ?? 0);
  if (count > 0) return;

  const generated = !config.adminPassword;
  const password = config.adminPassword || `${randomToken(12)}Aa1!`;
  const now = nowIso();
  run(
    `INSERT INTO users (username, password_hash, role, display_name, disabled, created_at, updated_at)
     VALUES (?, ?, 'admin', NULL, 0, ?, ?)`,
    config.adminUsername,
    await hashPassword(password),
    now,
    now,
  );

  if (generated) {
    app.log.warn(
      `首次启动已创建管理员账号：${config.adminUsername}，初始密码：${password}（仅显示一次，请登录后立即修改）`,
    );
  } else {
    app.log.info(`首次启动已根据环境变量创建管理员账号：${config.adminUsername}`);
  }
}
