import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createArtifactArchive } from '../src/pipeline/archive.js';
import type { ArtifactFile } from '../src/pipeline/artifact.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'myj-archive-'));

function hasTar(): boolean {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function artifactFiles(baseDir: string, names: string[]): ArtifactFile[] {
  return names.map((name) => {
    const localPath = path.join(baseDir, name);
    const stat = statSync(localPath);
    return { localPath, relativePath: name, mode: stat.mode & 0o777, size: stat.size };
  });
}

describe('产物压缩包', () => {
  it.skipIf(!hasTar())('打包目录产物并按原结构解压', async () => {
    const source = path.join(root, 'source');
    mkdirSync(path.join(source, 'assets/js'), { recursive: true });
    writeFileSync(path.join(source, 'index.html'), '<html>ok</html>');
    writeFileSync(path.join(source, 'assets/js/app.js'), 'console.log(1)');
    writeFileSync(path.join(source, 'assets/space name.txt'), 'text content');

    const files = artifactFiles(source, ['index.html', 'assets/js/app.js', 'assets/space name.txt']);
    const output = path.join(root, 'release.tar.gz');
    const archive = await createArtifactArchive(source, files, output);

    expect(archive.fileCount).toBe(3);
    expect(archive.bytes).toBeGreaterThan(0);
    expect(existsSync(`${output}.list`)).toBe(false);

    const extracted = path.join(root, 'extracted');
    mkdirSync(extracted);
    execFileSync('tar', ['-xzf', output, '-C', extracted], { stdio: 'ignore' });

    expect(readFileSync(path.join(extracted, 'index.html'), 'utf8')).toBe('<html>ok</html>');
    expect(readFileSync(path.join(extracted, 'assets/js/app.js'), 'utf8')).toBe('console.log(1)');
    expect(readFileSync(path.join(extracted, 'assets/space name.txt'), 'utf8')).toBe('text content');
  });

  it.skipIf(process.platform === 'win32' || !hasTar())('保留可执行权限', async () => {
    const source = path.join(root, 'mode-source');
    mkdirSync(source, { recursive: true });
    const bin = path.join(source, 'run.sh');
    writeFileSync(bin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const files = artifactFiles(source, ['run.sh']);
    const output = path.join(root, 'mode.tar.gz');
    await createArtifactArchive(source, files, output);

    const extracted = path.join(root, 'mode-extracted');
    mkdirSync(extracted);
    execFileSync('tar', ['-xzf', output, '-C', extracted], { stdio: 'ignore' });
    expect(statSync(path.join(extracted, 'run.sh')).mode & 0o111).not.toBe(0);
  });

  it('拒绝包含换行的产物文件名', async () => {
    const source = path.join(root, 'name-source');
    mkdirSync(source, { recursive: true });
    const output = path.join(root, 'bad.tar.gz');
    await expect(
      createArtifactArchive(
        source,
        [{ localPath: path.join(source, 'a'), relativePath: 'a\nb', mode: 0o644, size: 0 }],
        output,
      ),
    ).rejects.toThrow(/不支持的字符/);
  });

  it('拒绝超出目录的产物路径', async () => {
    const source = path.join(root, 'escape-source');
    mkdirSync(source, { recursive: true });
    await expect(
      createArtifactArchive(
        source,
        [{ localPath: path.join(source, 'a'), relativePath: '../a', mode: 0o644, size: 0 }],
        path.join(root, 'escape.tar.gz'),
      ),
    ).rejects.toThrow(/不合法/);
  });
});
