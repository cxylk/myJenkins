import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from './config.js';

export type Param = string | number | null | bigint | Uint8Array;

let database: DatabaseSync | null = null;

const SCHEMA_V1 = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  display_name TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE git_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('https_token', 'ssh_key')),
  username TEXT,
  secret_enc TEXT NOT NULL,
  passphrase_enc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'private_key')),
  secret_enc TEXT NOT NULL,
  passphrase_enc TEXT,
  host_key_fingerprint TEXT,
  trusted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  repo_url TEXT NOT NULL,
  credential_id INTEGER REFERENCES git_credentials(id) ON DELETE SET NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  build_enabled INTEGER NOT NULL DEFAULT 1,
  build_command TEXT,
  artifact_path TEXT NOT NULL,
  exclude_patterns TEXT NOT NULL DEFAULT '[]',
  build_timeout_sec INTEGER NOT NULL DEFAULT 900,
  deploy_timeout_sec INTEGER NOT NULL DEFAULT 300,
  on_target_failure TEXT NOT NULL DEFAULT 'abort' CHECK (on_target_failure IN ('abort', 'continue')),
  keep_workspace INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE project_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES servers(id),
  remote_dir TEXT NOT NULL,
  deploy_commands TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_project_targets_project ON project_targets(project_id, order_index);

CREATE TABLE builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT,
  commit_subject TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'success', 'failed', 'cancelled')),
  triggered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  log_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, number)
);
CREATE INDEX idx_builds_project ON builds(project_id, id DESC);
CREATE INDEX idx_builds_status ON builds(status);
CREATE INDEX idx_builds_created ON builds(created_at);

CREATE TABLE build_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  target_id INTEGER,
  server_id INTEGER,
  server_name TEXT NOT NULL,
  remote_dir TEXT NOT NULL,
  deploy_commands TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'success', 'failed', 'skipped', 'cancelled')),
  files_uploaded INTEGER NOT NULL DEFAULT 0,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER
);
CREATE INDEX idx_build_targets_build ON build_targets(build_id, id);
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: 'ALTER TABLE projects ADD COLUMN target_runtime TEXT;' },
];

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openDatabase(file: string = paths.db): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const instance = new DatabaseSync(file);
  instance.exec('PRAGMA journal_mode = WAL');
  instance.exec('PRAGMA foreign_keys = ON');
  instance.exec('PRAGMA busy_timeout = 5000');
  instance.exec('PRAGMA synchronous = NORMAL');
  migrate(instance);
  database = instance;
  return instance;
}

export function closeDatabase(): void {
  if (database) {
    database.close();
    database = null;
  }
}

export function db(): DatabaseSync {
  if (!database) throw new Error('数据库尚未初始化');
  return database;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db().prepare(sql).all(...params) as unknown as T[];
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return db().prepare(sql).get(...params) as unknown as T | undefined;
}

export function run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const result = db().prepare(sql).run(...params);
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

export function tx<T>(fn: () => T): T {
  const instance = db();
  instance.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    instance.exec('COMMIT');
    return value;
  } catch (error) {
    instance.exec('ROLLBACK');
    throw error;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
