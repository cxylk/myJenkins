import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectArtifact } from '../src/pipeline/artifact.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'myj-artifact-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function workspace(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('产物收集', () => {
  it('产物收集会忽略根目录下的 .git 文件（工作树模式）', async () => {
    const ws = workspace('worktree-case');
    writeFileSync(path.join(ws, '.git'), 'gitdir: /tmp/cache.git/worktrees/b-1');
    writeFileSync(path.join(ws, 'index.html'), 'ok');

    const artifact = await collectArtifact(ws, '.');
    expect(artifact.files.map((file) => file.relativePath)).toEqual(['index.html']);
  });
  it('目录产物保留相对结构，并应用排除规则', async () => {
    const ws = workspace('dir-case');
    mkdirSync(path.join(ws, 'dist/nested'), { recursive: true });
    writeFileSync(path.join(ws, 'dist/a.txt'), 'a');
    writeFileSync(path.join(ws, 'dist/nested/b.js'), 'b');
    writeFileSync(path.join(ws, 'dist/nested/skip.map'), 'map');

    const artifact = await collectArtifact(ws, 'dist', ['**/*.map']);
    expect(artifact.files.map((file) => file.relativePath).sort()).toEqual(['a.txt', 'nested/b.js']);
    expect(artifact.totalBytes).toBe(2);
    expect(artifact.files.every((file) => file.localPath.startsWith(ws))).toBe(true);
  });

  it('单个文件产物上传到远程目录根', async () => {
    const ws = workspace('file-case');
    mkdirSync(path.join(ws, 'target'), { recursive: true });
    writeFileSync(path.join(ws, 'target/app.jar'), 'jar');

    const artifact = await collectArtifact(ws, 'target/app.jar');
    expect(artifact.files).toHaveLength(1);
    expect(artifact.files[0].relativePath).toBe('app.jar');
  });

  it('glob 产物按静态前缀计算相对路径', async () => {
    const ws = workspace('glob-case');
    mkdirSync(path.join(ws, 'build/lib'), { recursive: true });
    writeFileSync(path.join(ws, 'build/lib/a.js'), 'a');
    writeFileSync(path.join(ws, 'build/lib/b.js'), 'b');
    writeFileSync(path.join(ws, 'build/ignore.txt'), 'x');

    const artifact = await collectArtifact(ws, 'build/lib/*.js');
    expect(artifact.files.map((file) => file.relativePath).sort()).toEqual(['a.js', 'b.js']);
  });

  it('路径不存在时给出可读错误', async () => {
    const ws = workspace('missing-case');
    await expect(collectArtifact(ws, 'dist')).rejects.toThrow(/产物路径不存在/);
  });

  it('拒绝超出工作区的路径', async () => {
    const ws = workspace('escape-case');
    await expect(collectArtifact(ws, '../outside.txt')).rejects.toThrow(/超出/);
  });

  it('目录为空时失败而不是静默成功', async () => {
    const ws = workspace('empty-case');
    mkdirSync(path.join(ws, 'dist'));
    await expect(collectArtifact(ws, 'dist')).rejects.toThrow(/未匹配到/);
  });

  it('跳过符号链接文件', async () => {
    const ws = workspace('symlink-case');
    mkdirSync(path.join(ws, 'dist'), { recursive: true });
    writeFileSync(path.join(ws, 'dist/real.txt'), 'real');
    try {
      symlinkSync(path.join(ws, 'dist/real.txt'), path.join(ws, 'dist/link.txt'));
    } catch {
      return;
    }
    const artifact = await collectArtifact(ws, 'dist');
    expect(artifact.files.map((file) => file.relativePath)).toEqual(['real.txt']);
  });
});
