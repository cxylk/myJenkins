import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config, paths } from './config.js';
import { AppError, CancelledError, badRequest } from './lib/errors.js';

const execFileAsync = promisify(execFile);

export interface GitAuth {
  authType: 'https_token' | 'ssh_key';
  username?: string | null;
  secret: string;
  passphrase?: string | null;
}

export interface GitRunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  auth?: GitAuth;
  onCommand?: (command: string) => void;
  onRetry?: (attempt: number, message: string) => void;
}

interface GitContext {
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
  secrets: string[];
}

const ASKPASS_SCRIPT = `#!/bin/sh\nprintf '%s\\n' "$MYJ_GIT_SECRET"\n`;

function quote(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function sanitizeCommand(args: string[], secrets: string[]): string {
  let text = `git ${args.map(quote).join(' ')}`;
  for (const secret of secrets) {
    if (!secret) continue;
    text = text.split(secret).join('***');
  }
  return text;
}

/** Remove every known secret and any Authorization header from free-form text. */
export function redactGitText(input: string, secrets: string[]): string {
  let text = input;
  for (const secret of secrets) {
    if (!secret) continue;
    text = text.split(secret).join('***');
  }
  return text
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, 'Authorization: Basic ***')
    .replace(/http\.extraHeader=[^\s'"]+/gi, 'http.extraHeader=***')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@');
}

async function ensureKnownHostsFile(): Promise<string> {
  await fs.mkdir(path.dirname(paths.gitKnownHosts), { recursive: true, mode: 0o700 });
  try {
    const stat = await fs.stat(paths.gitKnownHosts);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    await fs.writeFile(paths.gitKnownHosts, '', { mode: 0o600 }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  return paths.gitKnownHosts;
}

async function prepareContext(auth: GitAuth | undefined, baseEnv: NodeJS.ProcessEnv): Promise<GitContext> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
  };
  const args: string[] = [];
  const secrets: string[] = [];
  let cleanup = async () => undefined;

  if (!auth) return { args, env, cleanup, secrets };
  secrets.push(auth.secret);
  if (auth.passphrase) secrets.push(auth.passphrase);

  if (auth.authType === 'https_token') {
    const basic = Buffer.from(`${auth.username || 'git'}:${auth.secret}`, 'utf8').toString('base64');
    secrets.push(basic);
    // 通过环境变量传入 Git 配置，避免 Token 出现在进程 argv / ps / audit 日志中。
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    return { args, env, cleanup, secrets };
  }

  const dir = await fs.mkdtemp(path.join(paths.tmp, 'git-'));
  try {
    await fs.chmod(dir, 0o700);
    const keyPath = path.join(dir, 'id_key');
    await fs.writeFile(keyPath, auth.secret.endsWith('\n') ? auth.secret : `${auth.secret}\n`, { mode: 0o600 });

    // 持久化 known_hosts：首次连接接受并记住，后续同一主机必须匹配，避免每次操作都重新信任。
    const knownHosts = await ensureKnownHostsFile();
    const sshArgs = [
      'ssh',
      '-i',
      `"${keyPath}"`,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile="${knownHosts}"`,
      '-o',
      `BatchMode=${auth.passphrase ? 'no' : 'yes'}`,
    ];

    if (auth.passphrase) {
      const isWindows = process.platform === 'win32';
      const askpassPath = path.join(dir, isWindows ? 'askpass.cmd' : 'askpass.sh');
      if (isWindows) {
        await fs.writeFile(askpassPath, `@echo off\r\necho %MYJ_GIT_SECRET%\r\n`, { mode: 0o700 });
      } else {
        await fs.writeFile(askpassPath, ASKPASS_SCRIPT, { mode: 0o700 });
      }
      env.SSH_ASKPASS = askpassPath;
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.MYJ_GIT_SECRET = auth.passphrase;
    }

    env.GIT_SSH_COMMAND = sshArgs.join(' ');
    cleanup = async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return { args, env, cleanup, secrets };
}

function gitError(error: unknown, context: GitContext, aborted: boolean): AppError | CancelledError {
  const err = error as Error & { stderr?: string; stdout?: string; name?: string; code?: string; killed?: boolean };
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR' || aborted) {
    return new CancelledError('Git 操作已取消');
  }
  if (err.code === 'ENOENT') {
    return new AppError(500, 'GIT_MISSING', '服务器上未找到 git 命令，请先安装 git');
  }
  if (err.code === 'EPERM' || err.code === 'EACCES') {
    return new AppError(500, 'GIT_SPAWN', '无法启动 git 进程（权限被拒绝），请确认服务运行账户可以执行 git');
  }

  const stderr = redactGitText((err.stderr || '').toString().trim(), context.secrets);
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim());
  const tail = lines.slice(-6).join('\n');

  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for .* has changed/i.test(stderr)) {
    return new AppError(
      400,
      'GIT_HOST_KEY_CHANGED',
      'Git 服务器的主机指纹与已记录的不一致，连接被拒绝。若确认服务器重装过，请备份后删除 data/git_known_hosts 再重试',
    );
  }
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i.test(stderr)) {
    return new AppError(400, 'GIT_AUTH_FAILED', 'Git 认证失败，请检查凭据是否有效、是否有仓库权限');
  }
  if (/Remote branch .+ not found|Could not find remote branch/i.test(stderr)) {
    return new AppError(400, 'GIT_BRANCH_NOT_FOUND', '分支不存在，请刷新分支列表后重新选择');
  }
  if (/Repository not found|does not appear to be a git repository|returned error: 404/i.test(stderr)) {
    return new AppError(400, 'GIT_REPO_NOT_FOUND', '仓库不存在，或当前凭据没有访问权限');
  }
  if (err.killed) {
    return new AppError(400, 'GIT_TIMEOUT', 'Git 操作超时，请检查网络、仓库地址或代理配置');
  }

  return new AppError(400, 'GIT_FAILED', tail ? `Git 操作失败：${tail}` : 'Git 操作失败，且没有可用的错误输出');
}

async function runGit(rawArgs: string[], options: GitRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const context = await prepareContext(options.auth, options.env ?? {});
  const args = [...context.args, ...rawArgs];
  options.onCommand?.(sanitizeCommand(args, context.secrets));
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: options.cwd,
      env: context.env,
      timeout: options.timeoutMs ?? config.gitTimeoutMs,
      signal: options.signal,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { stdout, stderr };
  } catch (error) {
    throw gitError(error, context, Boolean(options.signal?.aborted));
  } finally {
    await context.cleanup();
  }
}

// Gogs/Nginx 偶发 5xx、RPC failed 或连接被重置，属于可重试的瞬态网络错误。
const TRANSIENT_GIT_ERROR =
  /HTTP\s+(?:500|502|503|504)|requested URL returned error:\s*5\d\d|RPC failed|remote end hung up|Connection reset|early EOF|Could not resolve host|Connection timed out|Operation timed out/i;

function isTransientGitError(error: unknown): boolean {
  return error instanceof AppError && TRANSIENT_GIT_ERROR.test(error.message);
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError('Git 操作已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError('Git 操作已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function runGitWithRetry(
  args: string[],
  options: GitRunOptions = {},
  attempts = 3,
): Promise<{ stdout: string; stderr: string }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runGit(args, options);
    } catch (error) {
      if (attempt >= attempts || !isTransientGitError(error)) throw error;
      options.onRetry?.(attempt, error instanceof Error ? error.message : String(error));
      await waitForRetry(attempt === 1 ? 5000 : 15000, options.signal);
    }
  }
}

export function normalizeRepoUrl(input: string): string {
  const value = (input ?? '').trim();
  if (!value) throw badRequest('仓库地址不能为空');
  if (/\s/.test(value)) throw badRequest('仓库地址不能包含空格');

  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) {
      throw badRequest('请把账号/Token 保存到 Git 凭据中，不要写在仓库地址里');
    }
    if (url.protocol === 'http:' && !config.allowInsecureGit) {
      throw badRequest('出于安全考虑不允许 http:// 仓库地址（如需内网 HTTP 仓库请设置 ALLOW_INSECURE_GIT=true）');
    }
    return value;
  }
  if (/^ssh:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.password) throw badRequest('仓库地址不能包含密码，请使用 SSH 私钥凭据');
    return value;
  }
  if (/^git:\/\//i.test(value)) {
    if (!config.allowInsecureGit) {
      throw badRequest('git:// 协议没有传输认证，已禁用；请改用 https:// 或 SSH');
    }
    return value;
  }
  const scpLike = /^([^@\s]+)@([^:\s]+):(.+)$/.exec(value);
  if (scpLike) {
    if (scpLike[1].includes(':')) throw badRequest('仓库地址不能包含密码，请使用 SSH 私钥凭据');
    return value;
  }
  if (config.allowFileRepos && (value.startsWith('file://') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))) {
    return value;
  }
  throw badRequest('仓库地址仅支持 https://、ssh:// 或 git@host:path 形式');
}

export function isValidBranchName(branch: string): boolean {
  if (!branch || branch.length > 200) return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) return false;
  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(branch)) return false;
  return true;
}

export async function listBranches(
  repoUrl: string,
  auth: GitAuth | undefined,
  options: { signal?: AbortSignal; onCommand?: (command: string) => void; timeoutMs?: number } = {},
): Promise<string[]> {
  const { stdout } = await runGitWithRetry(['ls-remote', '--heads', repoUrl], {
    auth,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    onCommand: options.onCommand,
  });
  const branches: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/.exec(line.trim());
    if (match) branches.push(match[1]);
  }
  return branches.sort((a, b) => a.localeCompare(b));
}

export async function cloneBranch(input: {
  repoUrl: string;
  branch: string;
  destination: string;
  auth?: GitAuth;
  timeoutMs?: number;
  signal?: AbortSignal;
  onCommand?: (command: string) => void;
}): Promise<{ commitSha: string; commitSubject: string }> {
  if (!isValidBranchName(input.branch)) throw badRequest(`分支名不合法：${input.branch}`);
  await fs.mkdir(path.dirname(input.destination), { recursive: true });
  await runGit(
    [
      'clone',
      '--depth',
      '1',
      '--single-branch',
      '--branch',
      input.branch,
      '--no-tags',
      '--quiet',
      input.repoUrl,
      input.destination,
    ],
    {
      auth: input.auth,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onCommand: input.onCommand,
    },
  );
  const [{ stdout: shaOut }, { stdout: subjectOut }] = await Promise.all([
    runGit(['-C', input.destination, 'rev-parse', 'HEAD'], { signal: input.signal }),
    runGit(['-C', input.destination, 'show', '-s', '--format=%s', 'HEAD'], { signal: input.signal }),
  ]);
  return { commitSha: shaOut.trim(), commitSubject: subjectOut.trim().slice(0, 500) };
}

async function isBareRepository(dir: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(['-C', dir, 'rev-parse', '--is-bare-repository']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export interface RepoCacheSyncInput {
  cacheDir: string;
  repoUrl: string;
  branch: string;
  auth?: GitAuth;
  timeoutMs?: number;
  signal?: AbortSignal;
  onCommand?: (command: string) => void;
  onRetry?: (attempt: number, message: string) => void;
}

export interface RepoCacheSyncResult {
  commitSha: string;
  commitSubject: string;
  created: boolean;
}

/**
 * Keep a bare shallow repository per project. The first build clones the branch
 * into the cache; later builds only fetch the missing commits. This avoids
 * re-downloading the whole tree on every release.
 */
export async function syncRepoCache(input: RepoCacheSyncInput): Promise<RepoCacheSyncResult> {
  if (!isValidBranchName(input.branch)) throw badRequest(`分支名不合法：${input.branch}`);
  await fs.mkdir(path.dirname(input.cacheDir), { recursive: true });

  let created = false;
  let valid = await isBareRepository(input.cacheDir);

  if (valid) {
    try {
      await runGit(['-C', input.cacheDir, 'remote', 'set-url', 'origin', input.repoUrl], {
        signal: input.signal,
      });
    } catch {
      valid = false;
    }
  }

  if (!valid) {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await fs.rm(input.cacheDir, { recursive: true, force: true });
      try {
        await runGit(
          [
            'clone',
            '--bare',
            '--depth',
            '1',
            '--single-branch',
            '--branch',
            input.branch,
            '--no-tags',
            '--quiet',
            input.repoUrl,
            input.cacheDir,
          ],
          {
            auth: input.auth,
            timeoutMs: input.timeoutMs,
            signal: input.signal,
            onCommand: input.onCommand,
          },
        );
        created = true;
        break;
      } catch (error) {
        lastError = error;
        await fs.rm(input.cacheDir, { recursive: true, force: true }).catch(() => undefined);
        if (attempt >= 3 || !isTransientGitError(error)) throw error;
        input.onRetry?.(attempt, error instanceof Error ? error.message : String(error));
        await waitForRetry(attempt === 1 ? 5000 : 15000, input.signal);
      }
    }
    if (!created) throw lastError ?? new AppError(500, 'GIT_CACHE', '仓库缓存初始化失败');
  } else {
    await runGitWithRetry(['-C', input.cacheDir, 'fetch', '--depth', '1', '--no-tags', 'origin', input.branch], {
      auth: input.auth,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onCommand: input.onCommand,
      onRetry: input.onRetry,
    });
    try {
      await runGit(['-C', input.cacheDir, 'worktree', 'prune'], { signal: input.signal });
    } catch {
      /* prune is best effort */
    }
  }

  const revision = created ? 'HEAD' : 'FETCH_HEAD';
  const { stdout: shaOut } = await runGit(['-C', input.cacheDir, 'rev-parse', `${revision}^{commit}`], {
    signal: input.signal,
  });
  const commitSha = shaOut.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commitSha)) {
    throw new AppError(500, 'GIT_CACHE', '无法解析仓库缓存中的提交');
  }
  const { stdout: subjectOut } = await runGit(
    ['-C', input.cacheDir, 'show', '-s', '--format=%s', commitSha],
    { signal: input.signal },
  );
  return { commitSha, commitSubject: subjectOut.trim().slice(0, 500), created };
}

/** Create a clean working tree from the cache without copying objects. */
export async function materializeRepoCache(input: {
  cacheDir: string;
  commitSha: string;
  destination: string;
  signal?: AbortSignal;
}): Promise<void> {
  await fs.rm(input.destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(input.destination), { recursive: true });
  await runGit(
    [
      '-C',
      input.cacheDir,
      'worktree',
      'add',
      '--detach',
      '--force',
      input.destination,
      input.commitSha,
    ],
    { signal: input.signal },
  );
}

/** Remove stale worktree registrations after a workspace has been deleted. */
export async function pruneRepoCache(cacheDir: string): Promise<void> {
  try {
    await runGit(['-C', cacheDir, 'worktree', 'prune']);
  } catch {
    /* cache may have been deleted with the project */
  }
}

export async function removeRepoCache(cacheDir: string): Promise<void> {
  await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
}

/** Cache is shared by every project pointing at the same repository URL. */
export function repoCachePath(repoUrl: string): string {
  const key = createHash('sha256').update(repoUrl, 'utf8').digest('hex').slice(0, 32);
  return path.join(paths.gitCache, `${key}.git`);
}

const repoCacheLocks = new Map<string, Promise<void>>();

async function waitForPreviousLock(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new CancelledError('发布已取消');
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new CancelledError('发布已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Serialize cache sync/checkout for one repository. Two projects may point at
 * the same Git repository; without this lock they would clone/fetch it at the
 * same time and overload the Git server.
 */
export async function withRepoCacheLock<T>(
  key: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new CancelledError('发布已取消');
  const previous = repoCacheLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  repoCacheLocks.set(key, tail);
  let acquired = false;

  try {
    await waitForPreviousLock(previous, signal);
    acquired = true;
    if (signal?.aborted) throw new CancelledError('发布已取消');
    return await fn();
  } finally {
    release();
    // If we never acquired the lock we must keep the tail: later waiters have
    // to wait for the current holder, not start immediately.
    if (acquired && repoCacheLocks.get(key) === tail) repoCacheLocks.delete(key);
  }
}
