import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'myj-git-data-'));
process.env.DATA_DIR = dataDir;
process.env.ALLOW_FILE_REPOS = 'true';

const { cloneBranch, isValidBranchName, listBranches, normalizeRepoUrl } = await import('../src/git.js');

let repoDir: string;
let repoUrl: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeAll(() => {
  repoDir = mkdtempSync(path.join(os.tmpdir(), 'myj-git-repo-'));
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  writeFileSync(path.join(repoDir, 'version.txt'), 'main');
  git(['add', '-A'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  git(['checkout', '-b', 'feature/login'], repoDir);
  writeFileSync(path.join(repoDir, 'version.txt'), 'feature');
  git(['commit', '-am', 'feature work'], repoDir);
  git(['checkout', 'main'], repoDir);
  repoUrl = pathToFileURL(repoDir).href;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe('Git 集成', () => {
  it('列举远程分支（含斜杠分支名）', async () => {
    const branches = await listBranches(repoUrl, undefined);
    expect(branches).toContain('main');
    expect(branches).toContain('feature/login');
  });

  it('浅克隆指定分支并返回提交信息', async () => {
    const destination = path.join(dataDir, 'clone-feature');
    const result = await cloneBranch({
      repoUrl,
      branch: 'feature/login',
      destination,
    });
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.commitSubject).toBe('feature work');
    expect(readFileSync(path.join(destination, 'version.txt'), 'utf8')).toBe('feature');
  });

  it('分支不存在时给出明确失败', async () => {
    const destination = path.join(dataDir, 'clone-missing');
    await expect(cloneBranch({ repoUrl, branch: 'no-such-branch', destination })).rejects.toThrow(/分支不存在/);
  });

  it('拒绝危险分支名', async () => {
    expect(isValidBranchName('feature/login')).toBe(true);
    for (const branch of ['-x', '../etc', 'a b', 'a..b', 'a:b', 'a~b', '']) {
      expect(isValidBranchName(branch)).toBe(false);
    }
  });

  it('仓库地址只允许受支持的协议', () => {
    expect(normalizeRepoUrl('https://example.com/a.git')).toBe('https://example.com/a.git');
    expect(normalizeRepoUrl('git@example.com:org/repo.git')).toBe('git@example.com:org/repo.git');
    expect(normalizeRepoUrl('ssh://git@example.com/repo.git')).toBe('ssh://git@example.com/repo.git');
    expect(() => normalizeRepoUrl('javascript:alert(1)')).toThrow();
    expect(() => normalizeRepoUrl('https://example.com/a b.git')).toThrow();
  });

  it('命令日志不包含凭据，Token 也不进入 argv', async () => {
    const commands: string[] = [];
    const branches = await listBranches(
      repoUrl,
      {
        authType: 'https_token',
        username: 'git',
        secret: 'very-secret-token',
      },
      { onCommand: (command) => commands.push(command) },
    );
    expect(branches).toContain('main');
    expect(commands.length).toBe(1);
    expect(commands[0]).not.toContain('very-secret-token');
    expect(commands[0]).not.toContain('Authorization');
    expect(commands[0]).not.toContain('http.extraHeader');
  });

  it('拒绝 URL 内嵌凭据、明文 HTTP 与 git:// 协议', () => {
    expect(() => normalizeRepoUrl('https://user:token@example.com/repo.git')).toThrow(/凭据/);
    expect(() => normalizeRepoUrl('http://example.com/repo.git')).toThrow(/http/);
    expect(() => normalizeRepoUrl('git://example.com/repo.git')).toThrow(/git:\/\//);
    expect(() => normalizeRepoUrl('user:pass@example.com:repo.git')).toThrow(/密码/);
  });
});
