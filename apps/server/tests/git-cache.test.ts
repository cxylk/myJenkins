import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'myj-cache-data-'));
process.env.DATA_DIR = dataDir;

const { materializeRepoCache, pruneRepoCache, removeRepoCache, syncRepoCache } = await import('../src/git.js');

let repoDir: string;
let repoUrl: string;
let cacheDir: string;

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeAll(() => {
  repoDir = mkdtempSync(path.join(os.tmpdir(), 'myj-cache-repo-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(path.join(repoDir, 'version.txt'), 'v1');
  git(['add', '-A']);
  git(['commit', '-m', 'commit v1']);
  git(['checkout', '-b', 'feature/cache']);
  writeFileSync(path.join(repoDir, 'feature.txt'), 'feature');
  git(['add', '-A']);
  git(['commit', '-m', 'feature work']);
  git(['checkout', 'main']);
  repoUrl = pathToFileURL(repoDir).href;
  cacheDir = path.join(dataDir, 'cache', 'p-1.git');
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe('仓库缓存与增量检出', () => {
  it('首次构建初始化缓存，后续增量拉取新提交', async () => {
    const first = await syncRepoCache({ cacheDir, repoUrl, branch: 'main' });
    expect(first.created).toBe(true);
    expect(first.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(cacheDir)).toBe(true);

    const firstWorkspace = path.join(dataDir, 'ws-first');
    await materializeRepoCache({ cacheDir, commitSha: first.commitSha, destination: firstWorkspace });
    expect(readFileSync(path.join(firstWorkspace, 'version.txt'), 'utf8')).toBe('v1');
    expect(existsSync(path.join(firstWorkspace, '.git'))).toBe(true);

    writeFileSync(path.join(repoDir, 'version.txt'), 'v2');
    git(['commit', '-am', 'commit v2']);

    const second = await syncRepoCache({ cacheDir, repoUrl, branch: 'main' });
    expect(second.created).toBe(false);
    expect(second.commitSha).not.toBe(first.commitSha);
    expect(second.commitSubject).toBe('commit v2');

    const secondWorkspace = path.join(dataDir, 'ws-second');
    await materializeRepoCache({ cacheDir, commitSha: second.commitSha, destination: secondWorkspace });
    expect(readFileSync(path.join(secondWorkspace, 'version.txt'), 'utf8')).toBe('v2');
  });

  it('缓存可以切换到同一仓库的其他分支', async () => {
    const feature = await syncRepoCache({ cacheDir, repoUrl, branch: 'feature/cache' });
    expect(feature.created).toBe(false);
    const workspace = path.join(dataDir, 'ws-feature');
    await materializeRepoCache({ cacheDir, commitSha: feature.commitSha, destination: workspace });
    expect(readFileSync(path.join(workspace, 'feature.txt'), 'utf8')).toBe('feature');
    expect(readFileSync(path.join(workspace, 'version.txt'), 'utf8')).toBe('v1');
  });

  it('缓存损坏时会自动重建', async () => {
    const brokenCache = path.join(dataDir, 'cache', 'p-2.git');
    mkdirSync(brokenCache, { recursive: true });
    writeFileSync(path.join(brokenCache, 'junk.txt'), 'not a repo');
    const result = await syncRepoCache({ cacheDir: brokenCache, repoUrl, branch: 'main' });
    expect(result.created).toBe(true);
    await removeRepoCache(brokenCache);
    expect(existsSync(brokenCache)).toBe(false);
  });

  it('清理工作区后可 prune 工作树记录', async () => {
    await pruneRepoCache(cacheDir);
    expect(existsSync(cacheDir)).toBe(true);
  });
});
