import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'myj-api-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'test-app-secret';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin12345';
process.env.ALLOW_FILE_REPOS = 'true';
process.env.NODE_ENV = 'test';

const { buildApp } = await import('../src/app.js');
const { openDatabase, closeDatabase } = await import('../src/db.js');
const { setSecretBox } = await import('../src/secret-box.js');
const { loadSecretBox } = await import('../src/lib/crypto.js');
const { ensureAdmin } = await import('../src/bootstrap.js');

let app: FastifyInstance;
let adminCookie = '';
let memberCookie = '';
let memberId = 0;
let credentialId = 0;
let serverId = 0;
let projectId = 0;

async function login(username: string, password: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  const cookie = response.cookies.find((item) => item.name === 'myj_sid');
  return { response, cookie: cookie ? `myj_sid=${cookie.value}` : '' };
}

function projectPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: '订单服务',
    description: '测试项目',
    repoUrl: 'https://example.com/order.git',
    credentialId,
    defaultBranch: 'main',
    buildEnabled: false,
    buildCommand: null,
    targetRuntime: 'linux-x64',
    artifactPath: 'dist',
    excludePatterns: [],
    buildTimeoutSec: 300,
    deployTimeoutSec: 60,
    onTargetFailure: 'abort',
    keepWorkspace: false,
    targets: [{ serverId, remoteDir: '/opt/order', deployCommands: 'echo ok', enabled: true }],
    memberIds: [memberId],
    ...overrides,
  };
}

beforeAll(async () => {
  openDatabase();
  setSecretBox(await loadSecretBox('test-app-secret'));
  app = await buildApp({ logger: false, serveStatic: false });
  await ensureAdmin(app);
  await app.ready();
  const admin = await login('admin', 'admin12345');
  adminCookie = admin.cookie;
});

afterAll(async () => {
  await app.close();
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('认证与权限', () => {
  it('健康检查无需登录', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });

  it('未登录访问业务接口返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(response.statusCode).toBe(401);
  });

  it('错误密码返回 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong-password' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('管理员登录后可以读取自身信息', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ username: 'admin', role: 'admin' });
  });

  it('创建普通成员并拒绝重复用户名', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { username: 'bob', password: 'bob-pass-123', role: 'member', displayName: 'Bob' },
    });
    expect(created.statusCode).toBe(201);
    memberId = created.json().user.id;

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { username: 'bob', password: 'bob-pass-123', role: 'member' },
    });
    expect(duplicate.statusCode).toBe(409);
  });
});

describe('凭据、服务器与项目', () => {
  it('创建凭据且接口不回显密钥', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: { cookie: adminCookie },
      payload: { name: '测试 Token', authType: 'https_token', username: 'git', secret: 'token-secret' },
    });
    expect(response.statusCode).toBe(201);
    credentialId = response.json().credential.id;
    expect(JSON.stringify(response.json())).not.toContain('token-secret');

    const list = await app.inject({ method: 'GET', url: '/api/credentials', headers: { cookie: adminCookie } });
    expect(JSON.stringify(list.json())).not.toContain('token-secret');
    expect(list.json().credentials[0]).toMatchObject({ name: '测试 Token', hasSecret: true });
  });

  it('非法 SSH 私钥会被拒绝', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: { cookie: adminCookie },
      payload: { name: 'bad key', authType: 'ssh_key', secret: 'not-a-key' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('创建服务器', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { cookie: adminCookie },
      payload: {
        name: '目标机',
        host: '10.0.0.10',
        port: 22,
        username: 'deploy',
        authType: 'password',
        secret: 'server-password',
      },
    });
    expect(response.statusCode).toBe(201);
    serverId = response.json().server.id;
    expect(response.json().server.trusted).toBe(false);
  });

  it('创建项目并绑定成员与发布目标', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: adminCookie },
      payload: projectPayload({ name: '订单服务' }),
    });
    expect(response.statusCode).toBe(201);
    const project = response.json().project;
    projectId = project.id;
    expect(project.targets).toHaveLength(1);
    expect(project.targetRuntime).toBe('linux-x64');
    expect(project.members.map((member: { id: number }) => member.id)).toEqual([memberId]);
  });

  it('可以复制项目配置、目标和成员，但不复制发布记录', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/copy`,
      headers: { cookie: adminCookie },
      payload: { name: '订单服务-副本' },
    });
    expect(response.statusCode).toBe(201);
    const copied = response.json().project;
    expect(copied.id).not.toBe(projectId);
    expect(copied.name).toBe('订单服务-副本');
    expect(copied.repoUrl).toBe('https://example.com/order.git');
    expect(copied.targetRuntime).toBe('linux-x64');
    expect(copied.targets).toHaveLength(1);
    expect(copied.targets[0].remoteDir).toBe('/opt/order');
    expect(copied.members.map((member: { id: number }) => member.id)).toEqual([memberId]);
    expect(copied.lastBuild).toBeNull();

    const builds = await app.inject({
      method: 'GET',
      url: `/api/builds?projectId=${copied.id}`,
      headers: { cookie: adminCookie },
    });
    expect(builds.statusCode).toBe(200);
    expect(builds.json().builds).toHaveLength(0);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${copied.id}`,
      headers: { cookie: adminCookie },
    });
    expect(removed.statusCode).toBe(200);
  });
  it('拒绝超出工作区的产物路径', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: adminCookie },
      payload: projectPayload({ artifactPath: '../etc/passwd' }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('不能超出');
  });

  it('拒绝格式不合法的目标运行时', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: adminCookie },
      payload: projectPayload({ targetRuntime: 'Linux/64' }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('目标运行时格式不合法');
  });

  it('新增项目时可从远程仓库预览分支', async () => {
    const repoDir = path.join(dataDir, 'branch-preview-repo');
    mkdirSync(repoDir, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(repoDir, 'README.md'), 'main');
    git('add', '-A');
    git('commit', '-m', 'init');
    git('checkout', '-b', 'release/1.0');
    writeFileSync(path.join(repoDir, 'README.md'), 'release');
    git('commit', '-am', 'release');

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/preview-branches',
      headers: { cookie: adminCookie },
      payload: { repoUrl: pathToFileURL(repoDir).href, credentialId: null },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().branches).toEqual(expect.arrayContaining(['main', 'release/1.0']));

    const member = await login('bob', 'bob-pass-123');
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/projects/preview-branches',
      headers: { cookie: member.cookie },
      payload: { repoUrl: pathToFileURL(repoDir).href, credentialId: null },
    });
    expect(forbidden.statusCode).toBe(403);
  });
  it('拒绝相对的远程目录', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: adminCookie },
      payload: projectPayload({ targets: [{ serverId, remoteDir: 'opt/app', enabled: true }] }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('拒绝同一服务器上的重复目录', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: adminCookie },
      payload: projectPayload({
        targets: [
          { serverId, remoteDir: '/opt/app', enabled: true },
          { serverId, remoteDir: '/opt/app/', enabled: true },
        ],
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('重复');
  });
});

describe('成员权限边界', () => {
  it('成员登录后只能看到被授权项目', async () => {
    const member = await login('bob', 'bob-pass-123');
    memberCookie = member.cookie;
    expect(memberCookie).not.toBe('');

    const projects = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie: memberCookie } });
    expect(projects.statusCode).toBe(200);
    expect(projects.json().projects).toHaveLength(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}`,
      headers: { cookie: memberCookie },
    });
    expect(detail.statusCode).toBe(200);
  });

  it('成员不能访问服务器、用户与凭据管理接口', async () => {
    for (const url of ['/api/servers', '/api/users', '/api/credentials']) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: memberCookie } });
      expect(response.statusCode).toBe(403);
    }
  });

  it('成员不能复制项目', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/copy`,
      headers: { cookie: memberCookie },
      payload: { name: '越权副本' },
    });
    expect(response.statusCode).toBe(403);
  });
  it('成员不能创建或修改项目', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: memberCookie },
      payload: projectPayload(),
    });
    expect(create.statusCode).toBe(403);

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      headers: { cookie: memberCookie },
      payload: projectPayload(),
    });
    expect(update.statusCode).toBe(403);
  });
});

describe('发布记录、取消与删除', () => {
  let firstBuildId = 0;

  it('成员可以触发发布（进入排队）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/builds`,
      headers: { cookie: memberCookie },
      payload: { branch: 'main' },
    });
    expect(response.statusCode).toBe(201);
    firstBuildId = response.json().build.id;
    expect(response.json().build.status).toBe('queued');
    expect(response.json().build.targets).toHaveLength(1);
  });

  it('危险分支名被拒绝', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/builds`,
      headers: { cookie: memberCookie },
      payload: { branch: '-evil' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('成员可以查看日志接口（空日志）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/builds/${firstBuildId}/log?offset=0`,
      headers: { cookie: memberCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ content: '', status: 'queued' });
  });

  it('取消排队中的发布', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/builds/${firstBuildId}/cancel`,
      headers: { cookie: memberCookie },
    });
    expect(response.statusCode).toBe(200);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/builds/${firstBuildId}`,
      headers: { cookie: memberCookie },
    });
    expect(detail.json().build.status).toBe('cancelled');
    expect(detail.json().build.targets[0].status).toBe('cancelled');
  });

  it('存在排队中的发布时禁止删除项目', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/builds`,
      headers: { cookie: adminCookie },
      payload: { branch: 'main' },
    });
    const buildId = created.json().build.id;

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: adminCookie },
    });
    expect(blocked.statusCode).toBe(409);

    await app.inject({
      method: 'POST',
      url: `/api/builds/${buildId}/cancel`,
      headers: { cookie: adminCookie },
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie: adminCookie },
    });
    expect(removed.statusCode).toBe(200);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}`,
      headers: { cookie: adminCookie },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('项目删除后凭据与服务器可删除', async () => {
    const credential = await app.inject({
      method: 'DELETE',
      url: `/api/credentials/${credentialId}`,
      headers: { cookie: adminCookie },
    });
    expect(credential.statusCode).toBe(200);

    const server = await app.inject({
      method: 'DELETE',
      url: `/api/servers/${serverId}`,
      headers: { cookie: adminCookie },
    });
    expect(server.statusCode).toBe(200);
  });

  it('不能删除或降级最后一个管理员', async () => {
    const demote = await app.inject({
      method: 'PATCH',
      url: '/api/users/1',
      headers: { cookie: adminCookie },
      payload: { role: 'member' },
    });
    expect(demote.statusCode).toBe(409);

    const remove = await app.inject({
      method: 'DELETE',
      url: '/api/users/1',
      headers: { cookie: adminCookie },
    });
    expect(remove.statusCode).toBe(400);
  });
});

describe('修改密码与会话失效', () => {
  it('原密码错误时拒绝修改', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/auth/password',
      headers: { cookie: adminCookie },
      payload: { oldPassword: 'wrong', newPassword: 'new-password-123' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('修改密码后旧会话失效、新会话可用', async () => {
    const change = await app.inject({
      method: 'PUT',
      url: '/api/auth/password',
      headers: { cookie: adminCookie },
      payload: { oldPassword: 'admin12345', newPassword: 'new-password-123' },
    });
    expect(change.statusCode).toBe(200);
    const newCookie = change.cookies.find((item) => item.name === 'myj_sid');
    expect(newCookie).toBeTruthy();

    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: adminCookie },
    });
    expect(oldSession.statusCode).toBe(401);

    const fresh = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `myj_sid=${newCookie!.value}` },
    });
    expect(fresh.statusCode).toBe(200);
    adminCookie = `myj_sid=${newCookie!.value}`;
  });

  it('登出后会话立即失效', async () => {
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: adminCookie },
    });
    expect(logout.statusCode).toBe(200);

    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(401);
  });
});
