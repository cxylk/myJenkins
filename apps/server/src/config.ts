import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

const appRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

export const config = {
  version: '0.1.0',
  host: process.env.HOST || '0.0.0.0',
  port: int(process.env.PORT, 8080),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(appRoot, 'data')),
  webDist: path.resolve(process.env.WEB_DIST || path.join(appRoot, 'apps/web/dist')),
  appSecret: process.env.APP_SECRET || '',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  maxConcurrency: Math.min(8, Math.max(1, int(process.env.MAX_CONCURRENCY, 2))),
  logMaxBytes: Math.max(1024 * 1024, int(process.env.LOG_MAX_BYTES, 50 * 1024 * 1024)),
  logRetentionDays: Math.max(1, int(process.env.LOG_RETENTION_DAYS, 90)),
  sessionDays: Math.max(1, int(process.env.SESSION_DAYS, 7)),
  buildTimeoutDefault: 900,
  cookieSecure: process.env.COOKIE_SECURE === 'true' ? true : process.env.COOKIE_SECURE === 'false' ? false : 'auto' as const,
  trustProxy: bool(process.env.TRUST_PROXY),
  allowFileRepos: bool(process.env.ALLOW_FILE_REPOS),
  allowInsecureGit: bool(process.env.ALLOW_INSECURE_GIT),
  gitTimeoutMs: Math.max(10_000, int(process.env.GIT_TIMEOUT_MS, 120_000)),
  uploadTimeoutMs: Math.max(60_000, int(process.env.UPLOAD_TIMEOUT_MS, 30 * 60_000)),
  maxBuildMinutes: Math.min(1440, Math.max(5, int(process.env.MAX_BUILD_MINUTES, 240))),
  sshConnectTimeoutMs: Math.max(5_000, int(process.env.SSH_CONNECT_TIMEOUT_MS, 15_000)),
  publicDir: path.resolve(process.env.PUBLIC_DIR || path.join(appRoot, 'apps/web/dist')),
};

export const paths = {
  db: path.join(config.dataDir, 'myjenkins.db'),
  logs: path.join(config.dataDir, 'logs'),
  workspaces: path.join(config.dataDir, 'workspaces'),
  tmp: path.join(config.dataDir, 'tmp'),
  masterKey: path.join(config.dataDir, 'master.key'),
  gitKnownHosts: path.join(config.dataDir, 'git_known_hosts'),
  gitCache: path.join(config.dataDir, 'cache', 'git'),
};

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
