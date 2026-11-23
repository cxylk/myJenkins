import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.js';
import { openDatabase } from './db.js';
import { loadSecretBox } from './lib/crypto.js';
import { setSecretBox } from './secret-box.js';
import { buildApp } from './app.js';
import { ensureAdmin } from './bootstrap.js';
import { scheduler } from './pipeline/scheduler.js';

for (const dir of [paths.logs, paths.workspaces, paths.tmp]) {
  fs.mkdirSync(dir, { recursive: true });
}

// 清理上次异常退出遗留的 Git 临时私钥目录
try {
  for (const entry of fs.readdirSync(paths.tmp)) {
    if (entry.startsWith('git-')) {
      fs.rmSync(path.join(paths.tmp, entry), { recursive: true, force: true });
    }
  }
} catch {
  /* best effort */
}

openDatabase();
setSecretBox(await loadSecretBox(config.appSecret));

const app = await buildApp();
await ensureAdmin(app);
await scheduler.init();

app.addHook('onClose', async () => {
  await scheduler.shutdown();
});

app.log.info(
  `myJenkins ${config.version} 启动中：http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`,
);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, '服务启动失败');
  process.exit(1);
}

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info(`收到 ${signal}，正在停止服务...`);
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
