import path from 'node:path';
import { badRequest } from './errors.js';

/** Normalize an absolute POSIX directory; reject traversal and control characters. */
export function normalizeRemoteDir(input: string): string {
  const value = (input ?? '').trim();
  if (!value) throw badRequest('远程目录不能为空');
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw badRequest('远程目录包含非法字符');
  }
  if (!value.startsWith('/')) throw badRequest('远程目录必须是绝对路径，例如 /opt/app');
  if (value.startsWith('~')) throw badRequest('远程目录不支持 ~，请使用绝对路径');
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (!normalized.startsWith('/')) throw badRequest('远程目录不合法');
  if (normalized.split('/').includes('..')) throw badRequest('远程目录不能包含 ..');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/**
 * Validate an artifact path relative to the remote directory.
 * Backslashes are legal characters in POSIX file names and are kept literally,
 * so a name like `a\..\..\x` cannot turn into a traversal after upload.
 */
export function assertSafeRelativePath(relative: string): string {
  if (!relative || relative.includes('\0')) throw badRequest('上传文件路径不合法');
  if (relative.startsWith('/') || relative.endsWith('/')) throw badRequest('上传文件路径不合法');
  if (/^[A-Za-z]:[\\/]/.test(relative)) throw badRequest('上传文件路径不合法');
  for (const segment of relative.split('/')) {
    if (!segment || segment === '.' || segment === '..') {
      throw badRequest(`上传文件路径包含非法片段：${relative}`);
    }
  }
  return relative;
}

/** Convert an OS-specific relative path into a validated POSIX relative path. */
export function toSafePosixRelative(relativeOs: string): string {
  return assertSafeRelativePath(relativeOs.split(path.sep).join('/'));
}

/** Join a remote directory and a validated relative path, rejecting escapes. */
export function safeRemoteJoin(remoteDir: string, relative: string): string {
  const dir = remoteDir.length > 1 ? remoteDir.replace(/\/+$/, '') : remoteDir;
  const safeRelative = assertSafeRelativePath(relative);
  const full = dir === '/' ? `/${safeRelative}` : `${dir}/${safeRelative}`;
  const normalized = path.posix.normalize(full);
  const prefix = dir === '/' ? '/' : `${dir}/`;
  if (normalized !== full || !normalized.startsWith(prefix)) {
    throw badRequest(`远程路径超出了目标目录：${relative}`);
  }
  return normalized;
}

/** Validate a workspace-relative artifact path (globs allowed). */
export function assertArtifactPath(input: string): string {
  const value = (input ?? '').trim();
  if (!value) throw badRequest('产物路径不能为空');
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw badRequest('产物路径必须是相对于项目工作区的路径');
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw badRequest('产物路径不能超出项目工作区');
  }
  return normalized.replace(/\/+$/, '');
}

export function assertInside(root: string, candidate: string, label = '路径'): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw badRequest(`${label}超出了允许的目录范围`);
  }
  return resolved;
}

export function isValidBranchName(branch: string): boolean {
  if (!branch || branch.length > 200) return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) return false;
  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(branch)) return false;
  if (branch.includes('\\')) return false;
  return true;
}
