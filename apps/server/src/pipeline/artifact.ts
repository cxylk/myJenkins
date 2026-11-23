import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { badRequest } from '../lib/errors.js';
import { assertInside, toSafePosixRelative } from '../lib/paths.js';

export interface ArtifactFile {
  localPath: string;
  relativePath: string;
  mode: number;
  size: number;
}

export interface ArtifactSet {
  files: ArtifactFile[];
  totalBytes: number;
  base: string;
}

const MAX_FILES = 100_000;

function baseOfPattern(pattern: string): string {
  const magicIndex = pattern.search(/[*?[\]{}()!+@]/);
  if (magicIndex === -1) return pattern;
  const prefix = pattern.slice(0, magicIndex);
  const slash = prefix.lastIndexOf('/');
  return slash === -1 ? '.' : prefix.slice(0, slash) || '/';
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve configured artifact path into the exact files to upload.
 * Semantics: a directory uploads its contents; a single file uploads into the
 * remote directory root; a glob uploads matches relative to its static prefix.
 */
export async function collectArtifact(
  workspace: string,
  artifactPath: string,
  excludes: string[] = [],
): Promise<ArtifactSet> {
  const configured = artifactPath.trim().replaceAll('\\', '/');
  if (!configured) throw badRequest('产物路径不能为空');
  const absoluteConfigured = path.resolve(workspace, configured);
  assertInside(workspace, absoluteConfigured, '产物路径');

  const dynamic = fg.isDynamicPattern(configured);
  let pattern = configured;
  let base = baseOfPattern(configured);
  let baseAbsolute = path.resolve(workspace, base);

  if (!dynamic) {
    if (!(await exists(absoluteConfigured))) {
      throw badRequest(`产物路径不存在：${configured}。请确认构建命令生成了该文件或目录`);
    }
    if (await isDirectory(absoluteConfigured)) {
      pattern = `${configured.replace(/\/+$/, '')}/**/*`;
      base = configured.replace(/\/+$/, '');
      baseAbsolute = absoluteConfigured;
    } else {
      const stat = await fs.lstat(absoluteConfigured);
      if (stat.isSymbolicLink()) throw badRequest('产物路径是符号链接，暂不支持发布符号链接文件');
      const relativePath = path.basename(absoluteConfigured);
      return {
        files: [
          {
            localPath: absoluteConfigured,
            relativePath: toSafePosixRelative(relativePath),
            mode: stat.mode & 0o777,
            size: stat.size,
          },
        ],
        totalBytes: stat.size,
        base: path.dirname(absoluteConfigured),
      };
    }
  }

  assertInside(workspace, baseAbsolute, '产物路径');
  const ignore = ['**/.git/**', '**/.git', '.git', ...excludes.filter((item) => item.trim())];
  const matches = await fg(pattern, {
    cwd: workspace,
    absolute: true,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
    ignore,
    suppressErrors: true,
  });

  if (matches.length === 0) {
    throw badRequest(`产物路径未匹配到任何文件：${configured}`);
  }
  if (matches.length > MAX_FILES) {
    throw badRequest(`产物文件数量过多（${matches.length}），超过 ${MAX_FILES} 个上限`);
  }

  const files: ArtifactFile[] = [];
  let totalBytes = 0;
  for (const absolute of matches.sort()) {
    const resolved = path.resolve(absolute);
    assertInside(workspace, resolved, '产物文件');
    const stat = await fs.lstat(resolved);
    if (!stat.isFile()) continue;
    const relativePath = toSafePosixRelative(path.relative(baseAbsolute, resolved));
    if (!relativePath || relativePath.startsWith('../') || path.posix.isAbsolute(relativePath)) {
      throw badRequest(`产物文件路径不合法：${relativePath}`);
    }
    files.push({
      localPath: resolved,
      relativePath,
      mode: stat.mode & 0o777,
      size: stat.size,
    });
    totalBytes += stat.size;
  }

  if (files.length === 0) throw badRequest(`产物路径未匹配到常规文件：${configured}`);
  return { files, totalBytes, base: baseAbsolute };
}
