import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Client } from 'ssh2';
import type { ConnectConfig, SFTPWrapper } from 'ssh2';
import { config } from './config.js';
import { AppError, CancelledError } from './lib/errors.js';
import { runPool } from './lib/pool.js';
import { normalizeRemoteDir, safeRemoteJoin } from './lib/paths.js';

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'private_key';
  secret: string;
  passphrase?: string | null;
  fingerprint?: string | null;
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ExecResult {
  code: number;
  signal?: string;
  timedOut: boolean;
}

export function fingerprintOfHostKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function friendlySshError(error: Error & { code?: string; level?: string }, host: string): AppError {
  const code = error.code ?? '';
  if (error.level === 'client-authentication') {
    return new AppError(400, 'SSH_AUTH_FAILED', `SSH 认证失败，请检查用户名与密码/私钥（${host}）`);
  }
  if (code === 'ECONNREFUSED') return new AppError(400, 'SSH_REFUSED', `无法连接 ${host}：端口拒绝连接`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new AppError(400, 'SSH_DNS', `无法解析主机名 ${host}`);
  if (code === 'ETIMEDOUT') return new AppError(400, 'SSH_TIMEOUT', `连接 ${host} 超时`);
  return new AppError(400, 'SSH_ERROR', `SSH 连接失败：${error.message}`);
}

export async function connectSsh(
  target: SshTarget,
  options: { acceptAnyHostKey?: boolean; signal?: AbortSignal } = {},
): Promise<{ client: Client; fingerprint: string }> {
  if (options.signal?.aborted) throw new CancelledError('SSH 连接已取消');
  if (!options.acceptAnyHostKey && !target.fingerprint) {
    throw new AppError(400, 'HOST_KEY_UNTRUSTED', '该服务器尚未信任主机指纹，请先在“服务器”页面测试连接并信任');
  }

  return new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint = '';
    let settled = false;
    const onAbort = () => finish(new CancelledError('SSH 连接已取消'));

    const cfg: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: config.sshConnectTimeoutMs,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        fingerprint = fingerprintOfHostKey(key);
        if (options.acceptAnyHostKey) return true;
        return fingerprint === target.fingerprint;
      },
    };
    if (target.authType === 'password') {
      cfg.password = target.secret;
    } else {
      cfg.privateKey = target.secret;
      if (target.passphrase) cfg.passphrase = target.passphrase;
    }

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      client.removeAllListeners('ready');
      client.removeAllListeners('error');
      if (error) {
        client.on('error', () => {
          /* ignore errors triggered by an aborted handshake */
        });
        try {
          client.destroy();
        } catch {
          try {
            client.end();
          } catch {
            /* ignore */
          }
        }
        if (error instanceof CancelledError) {
          reject(error);
          return;
        }
        if (target.fingerprint && fingerprint && fingerprint !== target.fingerprint) {
          reject(
            new AppError(400, 'HOST_KEY_MISMATCH', '服务器主机指纹与已信任的不一致，连接被拒绝（可能存在中间人攻击）', {
              expected: target.fingerprint,
              actual: fingerprint,
            }),
          );
          return;
        }
        reject(friendlySshError(error as Error & { code?: string; level?: string }, target.host));
        return;
      }
      client.on('error', () => {
        /* connection errors after ready are surfaced by channels */
      });
      resolve({ client, fingerprint });
    };

    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    client.once('ready', () => finish());
    client.once('error', (error) => finish(error as Error));
    try {
      client.connect(cfg);
    } catch (error) {
      finish(error as Error);
    }
  });
}

export function execRemote(client: Client, command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const { timeoutMs = 300_000, signal, onStdout, onStderr } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    let settled = false;
    let stream: { close: () => void } | null = null;
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => {
      settle(() => {
        try {
          stream?.close();
        } catch {
          /* ignore */
        }
        reject(new CancelledError());
      });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    client.exec(command, (error, channel) => {
      if (error) {
        settle(() => reject(new AppError(400, 'SSH_EXEC', `远程命令启动失败：${error.message}`)));
        return;
      }
      stream = channel;
      timer = setTimeout(() => {
        timedOut = true;
        try {
          channel.close();
        } catch {
          /* ignore */
        }
        settle(() => resolve({ code: 124, timedOut: true }));
      }, timeoutMs);

      channel.on('data', (data: Buffer) => onStdout?.(data.toString('utf8')));
      channel.stderr.on('data', (data: Buffer) => onStderr?.(data.toString('utf8')));
      channel.on('close', (code: number | null, signalName?: string) => {
        settle(() => resolve({ code: code ?? (timedOut ? 124 : 255), signal: signalName, timedOut }));
      });
      channel.on('error', (streamError: Error) => {
        settle(() => reject(new AppError(400, 'SSH_EXEC', `远程命令执行出错：${streamError.message}`)));
      });
    });
  });
}

function callback<T>(fn: (cb: (error: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((error, value) => (error ? reject(error) : resolve(value)));
  });
}

export async function openSftp(client: Client): Promise<SFTPWrapper> {
  return callback<SFTPWrapper>((cb) => client.sftp(cb));
}

async function remoteStat(sftp: SFTPWrapper, remotePath: string) {
  try {
    return await callback<{ isDirectory: () => boolean }>((cb) => sftp.stat(remotePath, cb));
  } catch {
    return null;
  }
}

export async function ensureRemoteDir(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  const parts = remoteDir.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    const existing = await remoteStat(sftp, current);
    if (existing) {
      if (!existing.isDirectory()) throw new AppError(400, 'REMOTE_NOT_DIR', `远程路径 ${current} 已存在但不是目录`);
      continue;
    }
    try {
      await callback<void>((cb) => sftp.mkdir(current, (error) => cb(error, undefined)));
    } catch (error) {
      const again = await remoteStat(sftp, current);
      if (!again?.isDirectory()) {
        throw new AppError(400, 'REMOTE_MKDIR', `创建远程目录失败：${current}（${(error as Error).message}）`);
      }
    }
  }
}

export interface UploadFile {
  localPath: string;
  relativePath: string;
  mode: number;
}

export interface UploadResult {
  filesUploaded: number;
  bytesUploaded: number;
  failures: Array<{ path: string; error: string }>;
}

export async function uploadFiles(
  client: Client,
  files: UploadFile[],
  remoteDir: string,
  options: {
    signal?: AbortSignal;
    concurrency?: number;
    onProgress?: (done: number, total: number, bytes: number) => void;
  } = {},
): Promise<UploadResult> {
  const normalizedDir = normalizeRemoteDir(remoteDir);
  if (options.signal?.aborted) throw new CancelledError();
  const sftp = await openSftp(client);
  await ensureRemoteDir(sftp, normalizedDir);
  const createdDirs = new Set<string>();

  const ensureParent = async (relativePath: string) => {
    const parts = relativePath.split('/').slice(0, -1);
    let current = normalizedDir;
    for (const part of parts) {
      current += `/${part}`;
      if (createdDirs.has(current)) continue;
      const existing = await remoteStat(sftp, current);
      if (!existing) {
        await callback<void>((cb) => sftp.mkdir(current, (error) => cb(error, undefined))).catch(() => undefined);
      }
      createdDirs.add(current);
    }
  };

  let filesUploaded = 0;
  let bytesUploaded = 0;
  const failures: UploadResult['failures'] = [];
  const total = files.length;
  const limit = options.concurrency ?? 4;

  await runPool(files, limit, async (file) => {
    if (options.signal?.aborted) throw new CancelledError();
    try {
      await ensureParent(file.relativePath);
      const remotePath = `${remoteDir}/${file.relativePath}`;
      await callback<void>((cb) =>
        sftp.fastPut(file.localPath, remotePath, { concurrency: 4 }, (error) => cb(error, undefined)),
      );
      filesUploaded += 1;
      try {
        const stat = await fs.promises.stat(file.localPath);
        bytesUploaded += stat.size;
      } catch {
        /* ignore */
      }
      if (file.mode & 0o111) {
        await callback<void>((cb) => sftp.chmod(remotePath, file.mode & 0o777, (error) => cb(error, undefined))).catch(
          () => undefined,
        );
      }
      options.onProgress?.(filesUploaded, total, bytesUploaded);
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      failures.push({ path: file.relativePath, error: (error as Error).message });
    }
  });

  if (options.signal?.aborted) throw new CancelledError('上传已取消');
  return { filesUploaded, bytesUploaded, failures };
}

export async function testConnection(
  target: SshTarget,
  options: { acceptAnyHostKey?: boolean } = {},
): Promise<{ ok: boolean; fingerprint?: string; system?: string; error?: string; elapsedMs: number }> {
  const started = Date.now();
  let client: Client | null = null;
  try {
    const connected = await connectSsh(target, options);
    client = connected.client;
    let output = '';
    const result = await execRemote(client, 'uname -a 2>/dev/null || ver', {
      timeoutMs: 10_000,
      onStdout: (chunk) => {
        output += chunk;
      },
    });
    return {
      ok: true,
      fingerprint: connected.fingerprint,
      system: output.trim().slice(0, 500) || (result.code === 0 ? 'ok' : `exit ${result.code}`),
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof AppError ? error.message : (error as Error).message,
      elapsedMs: Date.now() - started,
    };
  } finally {
    client?.end();
  }
}
