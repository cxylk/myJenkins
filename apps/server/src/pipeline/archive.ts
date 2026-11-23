import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError, CancelledError } from '../lib/errors.js';
import type { ArtifactFile } from './artifact.js';

export interface ArtifactArchive {
  path: string;
  bytes: number;
  fileCount: number;
}

/**
 * Pack artifact files into a single .tar.gz relative to the artifact base directory.
 * Paths are written one per line and passed via `tar -T` so thousands of files
 * never hit the OS command-line length limit.
 */
export async function createArtifactArchive(
  baseDir: string,
  files: ArtifactFile[],
  outputPath: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ArtifactArchive> {
  if (files.length === 0) throw new AppError(400, 'ARCHIVE_EMPTY', '没有可打包的产物文件');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const manifestPath = `${outputPath}.list`;

  const entries = files.map((file) => {
    const name = file.relativePath;
    if (!name || name.includes('\0') || /[\r\n]/.test(name)) {
      throw new AppError(400, 'ARTIFACT_NAME', `产物文件名包含不支持的字符：${name}`);
    }
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new AppError(400, 'ARTIFACT_NAME', `产物文件名不合法：${name}`);
    }
    return name.startsWith('./') ? name : `./${name}`;
  });

  await fs.writeFile(manifestPath, `${entries.join('\n')}\n`, { mode: 0o600 });
  const timeoutMs = options.timeoutMs ?? 300_000;

  try {
    await new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new CancelledError('压缩已取消'));
        return;
      }
      const child = spawn('tar', ['-czf', outputPath, '-C', baseDir, '-T', manifestPath], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let settled = false;
      let stderr = '';
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onAbort = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        finish(() => reject(new CancelledError('压缩已取消')));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        finish(() => reject(new AppError(408, 'ARCHIVE_TIMEOUT', '产物压缩超时，请检查磁盘或减少产物数量')));
      }, timeoutMs);

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < 8192) stderr += chunk;
      });
      child.on('error', (error) => {
        finish(() =>
          reject(
            new AppError(
              500,
              'ARCHIVE_SPAWN',
              (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? '运行环境缺少 tar 命令，无法压缩产物'
                : `启动 tar 失败：${error.message}`,
            ),
          ),
        );
      });
      child.on('close', (code) => {
        if (code === 0) {
          finish(resolve);
          return;
        }
        finish(() =>
          reject(
            new AppError(
              500,
              'ARCHIVE_FAILED',
              `产物压缩失败（退出码 ${code ?? 'null'}）：${stderr.trim().slice(-500) || '未知错误'}`,
            ),
          ),
        );
      });
    });

    const stat = await fs.stat(outputPath);
    if (stat.size === 0) throw new AppError(500, 'ARCHIVE_EMPTY', '压缩包为空，请检查产物文件');
    return { path: outputPath, bytes: stat.size, fileCount: files.length };
  } catch (error) {
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(manifestPath, { force: true }).catch(() => undefined);
  }
}
