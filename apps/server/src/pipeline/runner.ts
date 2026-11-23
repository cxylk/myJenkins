import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';
import { all, get, nowIso, run } from '../db.js';
import type { BuildRow, BuildTargetRow, CredentialRow, ProjectRow, TargetRow } from '../models.js';
import { AppError, CancelledError, throwIfAborted } from '../lib/errors.js';
import { secrets } from '../secret-box.js';
import { materializeRepoCache, repoCachePath, syncRepoCache, withRepoCacheLock, type GitAuth } from '../git.js';
import { connectSsh, execRemote, uploadFiles } from '../ssh.js';
import { collectArtifact } from './artifact.js';
import { createArtifactArchive } from './archive.js';
import { BuildLog, Redactor } from './log.js';
import { normalizeRemoteDir } from '../lib/paths.js';

interface DeployTargetRow {
  bt_id: number;
  server_id: number | null;
  server_name: string;
  remote_dir: string;
  deploy_commands: string;
  host: string | null;
  port: number | null;
  username: string | null;
  auth_type: 'password' | 'private_key' | null;
  secret_enc: string | null;
  passphrase_enc: string | null;
  host_key_fingerprint: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds % 60).toFixed(0)}s`;
}

function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

function messageOf(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function updateBuildTarget(
  buildId: number,
  buildTargetId: number,
  patch: Partial<
    Pick<
      BuildTargetRow,
      'status' | 'files_uploaded' | 'bytes_uploaded' | 'error' | 'started_at' | 'finished_at' | 'duration_ms'
    >
  >,
): void {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`);
    values.push(value as string | number | null);
  }
  if (fields.length === 0) return;
  run(`UPDATE build_targets SET ${fields.join(', ')} WHERE build_id = ? AND id = ?`, ...values, buildId, buildTargetId);
}

function updateBuild(buildId: number, patch: Record<string, string | number | null>): void {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  run(`UPDATE builds SET ${fields.join(', ')} WHERE id = ?`, ...values, buildId);
}

async function runLocalCommand(
  command: string,
  cwd: string,
  options: { timeoutMs: number; signal: AbortSignal; log: BuildLog; env?: Record<string, string> },
): Promise<void> {
  const isWindows = process.platform === 'win32';
  const file = isWindows ? 'cmd.exe' : '/bin/sh';
  const args = isWindows ? ['/d', '/s', '/c', command] : ['-lc', command];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, CI: 'true', MYJENKINS: '1', ...options.env },
      detached: !isWindows,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    let forceTimer: NodeJS.Timeout | null = null;

    const killTree = () => {
      try {
        if (!child.pid) return;
        if (isWindows) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal.removeEventListener('abort', onAbort);
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = () => {
      killTree();
      settle(() => reject(new CancelledError('发布已取消')));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // 进程树未能及时退出时兜底结束本次发布，避免调度锁被永久占用
      forceTimer = setTimeout(() => {
        settle(() =>
          reject(new AppError(408, 'BUILD_TIMEOUT', `构建命令超时（${Math.round(options.timeoutMs / 1000)} 秒），已终止`)),
        );
      }, 5000);
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      if (text) options.log.stdout(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      if (text) options.log.stderr(text);
    });
    child.on('error', (error) => {
      settle(() => reject(new AppError(500, 'BUILD_SPAWN', `无法启动构建命令：${error.message}`)));
    });
    child.on('close', (code, signalName) => {
      const restOut = stdoutDecoder.end();
      if (restOut) options.log.stdout(restOut);
      const restErr = stderrDecoder.end();
      if (restErr) options.log.stderr(restErr);
      if (timedOut) {
        settle(() =>
          reject(new AppError(408, 'BUILD_TIMEOUT', `构建命令超时（${Math.round(options.timeoutMs / 1000)} 秒），已终止`)),
        );
        return;
      }
      if (options.signal.aborted) {
        settle(() => reject(new CancelledError('发布已取消')));
        return;
      }
      if (code === 0) {
        settle(resolve);
        return;
      }
      settle(() =>
        reject(
          new AppError(
            400,
            'BUILD_FAILED',
            `构建命令执行失败（退出码 ${code ?? 'null'}${signalName ? `，信号 ${signalName}` : ''}）`,
          ),
        ),
      );
    });
  });
}

export async function executeBuild(buildId: number, signal: AbortSignal): Promise<void> {
  const build = get<BuildRow>('SELECT * FROM builds WHERE id = ?', buildId);
  if (!build) return;
  const project = get<ProjectRow>('SELECT * FROM projects WHERE id = ?', build.project_id);
  if (!project) {
    updateBuild(buildId, { status: 'failed', error: '项目已被删除', finished_at: nowIso() });
    return;
  }

  const targets = listTargets(build.id);
  const secretValues: string[] = [];
  const gitCredential = project.credential_id
    ? get<CredentialRow>('SELECT * FROM git_credentials WHERE id = ?', project.credential_id)
    : null;
  let gitAuth: GitAuth | undefined;
  if (gitCredential) {
    const gitSecret = secrets().decrypt(gitCredential.secret_enc);
    const gitPassphrase = gitCredential.passphrase_enc ? secrets().decrypt(gitCredential.passphrase_enc) : null;
    gitAuth = {
      authType: gitCredential.auth_type,
      username: gitCredential.username,
      secret: gitSecret,
      passphrase: gitPassphrase,
    };
    secretValues.push(gitSecret);
    if (gitPassphrase) secretValues.push(gitPassphrase);
    if (gitCredential.auth_type === 'https_token') {
      secretValues.push(Buffer.from(`${gitCredential.username || 'git'}:${gitSecret}`).toString('base64'));
    }
  }
  for (const target of targets) {
    if (!target.secret_enc) continue;
    if (target.auth_type === 'password') secretValues.push(secrets().decrypt(target.secret_enc));
    if (target.passphrase_enc) secretValues.push(secrets().decrypt(target.passphrase_enc));
  }

  const redactor = new Redactor(secretValues);
  const log = new BuildLog(path.join(paths.logs, `${build.id}.log`), config.logMaxBytes, redactor);
  const startedAt = new Date();
  updateBuild(buildId, { status: 'running', started_at: startedAt.toISOString(), error: null });

  const workspace = path.join(paths.workspaces, `p-${project.id}`, `b-${build.number}`);
  const repoCacheDir = repoCachePath(project.repo_url);
  const steps: string[] = ['准备工作区', '拉取代码'];
  if (project.build_enabled === 1) steps.push('执行构建');
  steps.push('收集产物', '发布到目标服务器');
  let stepIndex = 0;
  const nextStep = (title: string) => {
    stepIndex += 1;
    log.step(stepIndex, steps.length, title);
  };

  let success = false;
  let cancelled = false;
  let failure: string | null = null;
  let artifactArchive: Awaited<ReturnType<typeof createArtifactArchive>> | null = null;

  try {
    log.header(`myJenkins 发布 #${build.number} · ${project.name} · 分支 ${build.branch}`);
    log.info(`触发时间：${formatDateTime(startedAt)}`);
    log.info(`目标数量：${targets.length}`);

    throwIfAborted(signal);
    nextStep('准备工作区');
    log.info(`工作区：${workspace}`);

    throwIfAborted(signal);
    nextStep('拉取代码');
    log.info(`仓库：${project.repo_url}`);
    log.info('同步仓库缓存（首次全量克隆，之后增量更新；同一仓库的发布会自动排队）...');
    const cached = await withRepoCacheLock(repoCacheDir, signal, async () => {
      const synced = await syncRepoCache({
        cacheDir: repoCacheDir,
        repoUrl: project.repo_url,
        branch: build.branch,
        auth: gitAuth,
        timeoutMs: config.gitTimeoutMs,
        signal,
        onCommand: (command) => log.command(command),
        onRetry: (attempt, message) => {
          const firstLine = message.split(/\r?\n/)[0];
          log.info(`Git 网络异常，准备重试（第 ${attempt} 次失败）：${firstLine}`);
        },
      });
      log.info(synced.created ? '仓库缓存初始化完成' : '仓库缓存增量更新完成');
      await materializeRepoCache({
        cacheDir: repoCacheDir,
        commitSha: synced.commitSha,
        destination: workspace,
        signal,
      });
      return synced;
    });
    updateBuild(buildId, { commit_sha: cached.commitSha, commit_subject: cached.commitSubject });
    log.info(`提交：${cached.commitSha.slice(0, 10)} ${cached.commitSubject}`);

    if (project.build_enabled === 1) {
      throwIfAborted(signal);
      nextStep('执行构建');
      const command = (project.build_command ?? '').trim();
      if (!command) throw new AppError(400, 'NO_BUILD_COMMAND', '项目启用了构建，但没有填写构建命令');
      const runtime = (project.target_runtime ?? '').trim();
      const buildEnv: Record<string, string> = {};
      if (runtime) {
        // .NET 会把同名环境变量当作 MSBuild 属性，dotnet publish 因此自动按该平台发布；
        // SelfContained=false 保证只输出框架依赖产物，而不是连运行时一起打包。
        buildEnv.RuntimeIdentifier = runtime;
        buildEnv.SelfContained = 'false';
        buildEnv.MYJ_TARGET_RUNTIME = runtime;
        log.info(`目标运行时：${runtime}（框架依赖发布）`);
      }
      log.command(command);
      await runLocalCommand(command, workspace, {
        timeoutMs: project.build_timeout_sec * 1000,
        signal,
        log,
        env: buildEnv,
      });
      log.info('构建命令执行成功');
    }

    throwIfAborted(signal);
    nextStep('收集产物');
    const excludes = parseExcludes(project.exclude_patterns);
    const artifact = await collectArtifact(workspace, project.artifact_path, excludes);
    log.info(`产物路径：${project.artifact_path}`);
    log.info(`待上传：${artifact.files.length} 个文件，共 ${formatBytes(artifact.totalBytes)}`);
    if (artifact.files.length <= 20) {
      for (const file of artifact.files) log.info(`  - ${file.relativePath} (${formatBytes(file.size)})`);
    }

    if (targets.length === 0) throw new AppError(400, 'NO_TARGETS', '项目没有启用中的发布目标');

    throwIfAborted(signal);
    const archivePath = path.join(paths.tmp, `build-${build.id}.tar.gz`);
    const archive = await createArtifactArchive(artifact.base, artifact.files, archivePath, {
      timeoutMs: 300_000,
      signal,
    });
    artifactArchive = archive;
    log.info(
      `打包完成：${artifact.files.length} 个文件，${formatBytes(artifact.totalBytes)} → ${formatBytes(archive.bytes)}`,
    );

    throwIfAborted(signal);
    nextStep('发布到目标服务器');
    const targetErrors: string[] = [];

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      throwIfAborted(signal);
      const targetStarted = new Date();
      updateBuildTarget(buildId, target.bt_id, {
        status: 'running',
        started_at: targetStarted.toISOString(),
        error: null,
      });
      log.blank();
      log.info(`--- 目标 ${index + 1}/${targets.length}：${target.server_name} (${target.host ?? '服务器已删除'}) ---`);
      log.info(`远程目录：${target.remote_dir}`);

      try {
        if (!target.host || !target.username || !target.auth_type || !target.secret_enc) {
          throw new AppError(
            400,
            'TARGET_SERVER_MISSING',
            `发布目标 ${target.server_name} 对应的服务器已被删除，无法连接`,
          );
        }
        if (!target.host_key_fingerprint) {
          throw new AppError(
            400,
            'HOST_KEY_UNTRUSTED',
            `服务器 ${target.server_name} 尚未信任主机指纹，请先在“服务器”页面测试并信任`,
          );
        }
        const connected = await connectSsh(
          {
            host: target.host,
            port: target.port ?? 22,
            username: target.username,
            authType: target.auth_type,
            secret: secrets().decrypt(target.secret_enc),
            passphrase: target.passphrase_enc ? secrets().decrypt(target.passphrase_enc) : null,
            fingerprint: target.host_key_fingerprint,
          },
          { signal },
        );
        const destroyOnAbort = () => {
          try {
            connected.client.destroy();
          } catch {
            /* ignore */
          }
        };
        signal.addEventListener('abort', destroyOnAbort, { once: true });

        try {
          const remoteDir = normalizeRemoteDir(target.remote_dir);
          const archiveName = `.myjenkins-upload-${build.id}.tar.gz`;
          log.info(`上传压缩包：${formatBytes(archive.bytes)}（含 ${artifact.files.length} 个文件）...`);
          let lastProgress = 0;
          let uploadTimedOut = false;
          const uploadTimer = setTimeout(() => {
            uploadTimedOut = true;
            destroyOnAbort();
          }, config.uploadTimeoutMs);
          let upload: Awaited<ReturnType<typeof uploadFiles>>;
          try {
            upload = await uploadFiles(
              connected.client,
              [{ localPath: archive.path, relativePath: archiveName, mode: 0o600 }],
              remoteDir,
              {
                signal,
                concurrency: 1,
                onProgress: (done, total, bytes) => {
                  if (done === total || Date.now() - lastProgress > 2500) {
                    lastProgress = Date.now();
                    log.info(`上传进度：${done}/${total}，${formatBytes(bytes)}`);
                  }
                },
              },
            );
          } catch (error) {
            if (uploadTimedOut) {
              throw new AppError(
                408,
                'UPLOAD_TIMEOUT',
                `上传超时（${Math.round(config.uploadTimeoutMs / 60_000)} 分钟），已中断连接`,
              );
            }
            throw error;
          } finally {
            clearTimeout(uploadTimer);
          }
          if (uploadTimedOut) {
            throw new AppError(408, 'UPLOAD_TIMEOUT', '上传超时，已中断连接');
          }
          if (upload.failures.length > 0) {
            for (const failureItem of upload.failures.slice(0, 20)) {
              log.error(`上传失败：${failureItem.path} — ${failureItem.error}`);
            }
            throw new AppError(
              500,
              'UPLOAD_PARTIAL',
              `${upload.failures.length} 个文件上传失败（首个：${upload.failures[0].path}）`,
            );
          }
          log.info(`压缩包上传完成：${formatBytes(upload.bytesUploaded)}`);

          log.info('正在解压到目标目录（全量覆盖）...');
          let extractError = '';
          const extractResult = await execRemote(
            connected.client,
            `cd ${shellQuote(remoteDir)} && tar -xzf ${shellQuote(archiveName)} && rm -f ${shellQuote(archiveName)}`,
            {
              timeoutMs: Math.max(120_000, project.deploy_timeout_sec * 1000),
              signal,
              onStdout: (chunk) => log.write(chunk),
              onStderr: (chunk) => {
                extractError += chunk;
                log.write(chunk);
              },
            },
          );
          if (extractResult.timedOut) {
            throw new AppError(408, 'EXTRACT_TIMEOUT', '远程解压超时，请检查目标机磁盘或减少产物体积');
          }
          if (extractResult.code !== 0) {
            log.error(`远程压缩包保留在：${remoteDir}/${archiveName}`);
            const tail = extractError.trim().split(/\r?\n/).slice(-5).join('；');
            throw new AppError(
              500,
              'EXTRACT_FAILED',
              `远程解压失败（退出码 ${extractResult.code}）${tail ? `：${tail}` : ''}`,
            );
          }
          log.info(`解压完成：${artifact.files.length} 个文件，${formatBytes(artifact.totalBytes)}`);
          updateBuildTarget(buildId, target.bt_id, {
            files_uploaded: artifact.files.length,
            bytes_uploaded: artifact.totalBytes,
          });

          const script = (target.deploy_commands ?? '').trim();
          if (script) {
            log.info('执行发布命令：');
            log.command(script);
            const command = `bash -lc ${shellQuote(`cd ${shellQuote(normalizeRemoteDir(target.remote_dir))} && ${script}`)}`;
            const result = await execRemote(connected.client, command, {
              timeoutMs: project.deploy_timeout_sec * 1000,
              signal,
              onStdout: (chunk) => log.write(chunk),
              onStderr: (chunk) => log.write(chunk),
            });
            if (result.timedOut) {
              throw new AppError(
                408,
                'DEPLOY_TIMEOUT',
                `发布命令超时（${project.deploy_timeout_sec} 秒），已中断`,
              );
            }
            if (result.code !== 0) {
              throw new AppError(500, 'DEPLOY_FAILED', `发布命令执行失败（退出码 ${result.code}）`);
            }
            log.info('发布命令执行成功');
          }

          const duration = Date.now() - targetStarted.getTime();
          updateBuildTarget(buildId, target.bt_id, {
            status: 'success',
            finished_at: new Date().toISOString(),
            duration_ms: duration,
            error: null,
          });
          log.info(`目标发布成功，耗时 ${formatDuration(duration)}`);
        } finally {
          signal.removeEventListener('abort', destroyOnAbort);
          try {
            connected.client.end();
          } catch {
            /* ignore */
          }
        }
      } catch (error) {
        if (error instanceof CancelledError || signal.aborted) throw error;
        const message = redactor.redact(messageOf(error));
        log.error(`目标发布失败：${message}`);
        updateBuildTarget(buildId, target.bt_id, {
          status: 'failed',
          error: message,
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - targetStarted.getTime(),
        });
        targetErrors.push(`${target.server_name}: ${message}`);
        if (project.on_target_failure === 'abort') {
          for (let rest = index + 1; rest < targets.length; rest += 1) {
            updateBuildTarget(buildId, targets[rest].bt_id, {
              status: 'skipped',
              error: '因前序目标失败而跳过',
            });
          }
          throw error;
        }
      }
    }

    if (targetErrors.length > 0) {
      throw new AppError(500, 'TARGETS_FAILED', `有 ${targetErrors.length} 个目标发布失败：${targetErrors.join('；')}`);
    }

    success = true;
  } catch (error) {
    if (error instanceof CancelledError || signal.aborted) {
      const timedOutBuild = signal.reason === 'timeout';
      cancelled = !timedOutBuild;
      failure = timedOutBuild
        ? `发布超过最大执行时长（${config.maxBuildMinutes} 分钟），已强制终止`
        : '发布已取消';
    } else {
      failure = redactor.redact(messageOf(error));
    }
  } finally {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const status = cancelled ? 'cancelled' : success ? 'success' : 'failed';
    const finalError = success ? null : (failure ?? '未知错误');

    log.blank();
    if (status === 'success') {
      log.info(`发布成功，总耗时 ${formatDuration(durationMs)}`);
    } else if (status === 'cancelled') {
      log.info(`发布已取消，总耗时 ${formatDuration(durationMs)}`);
    } else {
      log.error(`发布失败：${finalError}`);
      log.info(`总耗时 ${formatDuration(durationMs)}`);
      if (project.keep_workspace === 1) log.info(`失败工作区保留在：${workspace}`);
    }
    log.header(`发布结束 · #${build.number} · ${status}`);

    await log.close();
    let logSize = log.size;
    try {
      logSize = (await fs.stat(log.filePath)).size;
    } catch {
      /* ignore */
    }

    if (artifactArchive) {
      await fs.rm(artifactArchive.path, { force: true }).catch(() => undefined);
    }

    if (!(status === 'failed' && project.keep_workspace === 1)) {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
    if (status === 'cancelled') {
      run(
        `UPDATE build_targets SET status = 'cancelled', finished_at = ?, error = COALESCE(error, '发布已取消')
         WHERE build_id = ? AND status IN ('queued', 'running')`,
        finishedAt.toISOString(),
        buildId,
      );
    } else if (status === 'failed') {
      run(
        `UPDATE build_targets SET status = 'skipped', finished_at = ?, error = COALESCE(error, '发布在到达该目标前失败')
         WHERE build_id = ? AND status = 'queued'`,
        finishedAt.toISOString(),
        buildId,
      );
      run(
        `UPDATE build_targets SET status = 'failed', finished_at = ?, error = COALESCE(error, ?)
         WHERE build_id = ? AND status = 'running'`,
        finishedAt.toISOString(),
        finalError,
        buildId,
      );
    }

    updateBuild(buildId, {
      status,
      finished_at: finishedAt.toISOString(),
      duration_ms: durationMs,
      error: finalError,
      log_size: logSize,
    });
  }
}

function parseExcludes(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function listTargets(buildId: number): DeployTargetRow[] {
  return all<DeployTargetRow>(
    `SELECT bt.id AS bt_id, bt.server_id, bt.server_name, bt.remote_dir, bt.deploy_commands,
       s.host, s.port, s.username, s.auth_type, s.secret_enc, s.passphrase_enc, s.host_key_fingerprint
     FROM build_targets bt LEFT JOIN servers s ON s.id = bt.server_id
     WHERE bt.build_id = ?
     ORDER BY bt.id ASC`,
    buildId,
  );
}
