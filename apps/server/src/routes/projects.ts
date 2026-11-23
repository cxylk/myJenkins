import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, nowIso, run, tx } from '../db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { assertArtifactPath, normalizeRemoteDir } from '../lib/paths.js';
import { secrets } from '../secret-box.js';
import { normalizeRepoUrl, isValidBranchName, listBranches, repoCachePath, type GitAuth } from '../git.js';
import type { CredentialRow, ProjectRow, ServerRow, TargetRow, UserRow } from '../models.js';
import { currentUser, requireAdmin } from '../auth/plugin.js';
import { assertProjectAccess, loadProject } from '../access.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';

const targetSchema = z.object({
  id: z.number().int().positive().optional(),
  serverId: z.number().int().positive(),
  remoteDir: z.string().min(1, '远程目录不能为空'),
  deployCommands: z.string().max(50_000).default(''),
  enabled: z.boolean().default(true),
});

const projectSchema = z.object({
  name: z.string().trim().min(1, '项目名称不能为空').max(80),
  description: z.string().max(1000).default(''),
  repoUrl: z.string().min(1),
  credentialId: z.number().int().positive().nullable().optional(),
  defaultBranch: z.string().min(1).max(200).default('main'),
  buildEnabled: z.boolean().default(true),
  buildCommand: z.string().max(20_000).optional().nullable(),
  targetRuntime: z
    .string()
    .trim()
    .max(50)
    .regex(/^[a-z0-9][a-z0-9-]*$/, '目标运行时格式不合法')
    .optional()
    .nullable(),
  artifactPath: z.string().min(1).max(500),
  excludePatterns: z.array(z.string().max(200)).max(50).default([]),
  buildTimeoutSec: z.number().int().min(30).max(86_400).default(900),
  deployTimeoutSec: z.number().int().min(10).max(86_400).default(300),
  onTargetFailure: z.enum(['abort', 'continue']).default('abort'),
  keepWorkspace: z.boolean().default(false),
  targets: z.array(targetSchema).min(1, '至少需要配置一个发布目标').max(20),
  memberIds: z.array(z.number().int().positive()).max(500).optional(),
});

const membersSchema = z.object({
  userIds: z.array(z.number().int().positive()).max(500),
});

const previewBranchesSchema = z.object({
  repoUrl: z.string().trim().min(1, '请输入仓库地址').max(1000),
  credentialId: z.number().int().positive().nullable().optional(),
});

const copyProjectSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});

interface ProjectListRow extends ProjectRow {
  credential_name: string | null;
  last_build_id: number | null;
  last_build_number: number | null;
  last_status: string | null;
  last_branch: string | null;
  last_commit_sha: string | null;
  last_build_at: string | null;
}

interface ProjectContext {
  credential: CredentialRow | null;
}

function gitAuth(credential: CredentialRow | null): GitAuth | undefined {
  if (!credential) return undefined;
  return {
    authType: credential.auth_type,
    username: credential.username,
    secret: secrets().decrypt(credential.secret_enc),
    passphrase: credential.passphrase_enc ? secrets().decrypt(credential.passphrase_enc) : null,
  };
}

function projectContext(project: ProjectRow): ProjectContext {
  const credential = project.credential_id
    ? get<CredentialRow>('SELECT * FROM git_credentials WHERE id = ?', project.credential_id) ?? null
    : null;
  return { credential };
}

function lastBuild(projectId: number) {
  const row = get<{
    id: number;
    number: number;
    status: string;
    branch: string;
    commit_sha: string | null;
    created_at: string;
    finished_at: string | null;
  }>(
    'SELECT id, number, status, branch, commit_sha, created_at, finished_at FROM builds WHERE project_id = ? ORDER BY id DESC LIMIT 1',
    projectId,
  );
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    branch: row.branch,
    commitSha: row.commit_sha,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function projectDetail(project: ProjectRow) {
  const credential = project.credential_id
    ? get<{ name: string }>('SELECT name FROM git_credentials WHERE id = ?', project.credential_id)
    : null;
  const targetRows = all<TargetRow & { server_name: string; host: string; port: number; server_username: string }>(
    `SELECT t.*, s.name AS server_name, s.host, s.port, s.username AS server_username
     FROM project_targets t JOIN servers s ON s.id = t.server_id
     WHERE t.project_id = ? ORDER BY t.order_index ASC, t.id ASC`,
    project.id,
  );
  const members = all<UserRow>(
    `SELECT u.* FROM project_members m JOIN users u ON u.id = m.user_id
     WHERE m.project_id = ? ORDER BY u.id ASC`,
    project.id,
  );

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    repoUrl: project.repo_url,
    credentialId: project.credential_id,
    credentialName: credential?.name ?? null,
    defaultBranch: project.default_branch,
    buildEnabled: project.build_enabled === 1,
    buildCommand: project.build_command,
    targetRuntime: project.target_runtime,
    artifactPath: project.artifact_path,
    excludePatterns: safeJsonArray(project.exclude_patterns),
    buildTimeoutSec: project.build_timeout_sec,
    deployTimeoutSec: project.deploy_timeout_sec,
    onTargetFailure: project.on_target_failure,
    keepWorkspace: project.keep_workspace === 1,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    targets: targetRows.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name,
      host: row.host,
      port: row.port,
      username: row.server_username,
      remoteDir: row.remote_dir,
      deployCommands: row.deploy_commands,
      enabled: row.enabled === 1,
      orderIndex: row.order_index,
    })),
    members: members.map((member) => ({
      id: member.id,
      username: member.username,
      displayName: member.display_name,
      role: member.role,
    })),
    lastBuild: lastBuild(project.id),
  };
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function validateTargets(targets: z.infer<typeof targetSchema>[]): void {
  const pairs = new Set<string>();
  for (const target of targets) {
    const server = get<ServerRow>('SELECT * FROM servers WHERE id = ?', target.serverId);
    if (!server) throw badRequest(`发布目标引用的服务器不存在（ID ${target.serverId}）`);
    const remoteDir = normalizeRemoteDir(target.remoteDir);
    const key = `${target.serverId}|${remoteDir}`;
    if (pairs.has(key)) throw badRequest('同一台服务器不能配置重复的远程目录');
    pairs.add(key);
  }
}

function validateCredential(credentialId: number | null | undefined): void {
  if (!credentialId) return;
  const credential = get<CredentialRow>('SELECT * FROM git_credentials WHERE id = ?', credentialId);
  if (!credential) throw badRequest('Git 凭据不存在');
}

function replaceMembers(projectId: number, memberIds: number[]): void {
  run('DELETE FROM project_members WHERE project_id = ?', projectId);
  for (const userId of [...new Set(memberIds)]) {
    const user = get<{ id: number }>('SELECT id FROM users WHERE id = ?', userId);
    if (!user) throw badRequest(`成员不存在（ID ${userId}）`);
    run('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)', projectId, userId);
  }
}

const branchCache = new Map<number, { at: number; branches: string[] }>();

export function invalidateBranchCache(projectId?: number): void {
  if (projectId === undefined) branchCache.clear();
  else branchCache.delete(projectId);
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req) => {
    const user = currentUser(req);
    const rows = all<ProjectListRow>(
      `SELECT p.*, c.name AS credential_name,
        (SELECT b.id FROM builds b WHERE b.project_id = p.id ORDER BY b.id DESC LIMIT 1) AS last_build_id,
        (SELECT b.number FROM builds b WHERE b.project_id = p.id ORDER BY b.id DESC LIMIT 1) AS last_build_number,
        (SELECT b.status FROM builds b WHERE b.project_id = p.id ORDER BY b.id DESC LIMIT 1) AS last_status,
        (SELECT b.branch FROM builds b WHERE b.project_id = p.id ORDER BY b.id DESC LIMIT 1) AS last_branch,
        (SELECT b.commit_sha FROM builds b WHERE b.project_id = p.id ORDER BY b.id DESC LIMIT 1) AS last_commit_sha,
        (SELECT b.created_at FROM builds b WHERE b.project_id = p.id ORDER BY b.id DESC LIMIT 1) AS last_build_at
       FROM projects p
       LEFT JOIN git_credentials c ON c.id = p.credential_id
       ${user.role === 'admin' ? '' : 'WHERE p.id IN (SELECT project_id FROM project_members WHERE user_id = ?)'}
       ORDER BY p.id DESC`,
      ...(user.role === 'admin' ? [] : [user.id]),
    );
    return {
      projects: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        repoUrl: row.repo_url,
        defaultBranch: row.default_branch,
        credentialName: row.credential_name,
        buildEnabled: row.build_enabled === 1,
        targetCount: Number(
          get<{ c: number }>('SELECT COUNT(*) AS c FROM project_targets WHERE project_id = ? AND enabled = 1', row.id)?.c ?? 0,
        ),
        createdAt: row.created_at,
        lastBuild: row.last_build_id
          ? {
              id: row.last_build_id,
              number: row.last_build_number,
              status: row.last_status,
              branch: row.last_branch,
              commitSha: row.last_commit_sha,
              createdAt: row.last_build_at,
            }
          : null,
      })),
    };
  });

  app.post('/', async (req, reply) => {
    const user = requireAdmin(req);
    const body = projectSchema.parse(req.body);
    const repoUrl = normalizeRepoUrl(body.repoUrl);
    if (!isValidBranchName(body.defaultBranch)) throw badRequest('默认分支名不合法');
    if (body.buildEnabled && !body.buildCommand?.trim()) throw badRequest('启用构建时必须填写构建命令');
    assertArtifactPath(body.artifactPath);
    validateTargets(body.targets);
    validateCredential(body.credentialId ?? null);

    const now = nowIso();
    const projectId = tx(() => {
      const result = run(
        `INSERT INTO projects (name, description, repo_url, credential_id, default_branch, build_enabled, build_command,
          target_runtime, artifact_path, exclude_patterns, build_timeout_sec, deploy_timeout_sec, on_target_failure,
          keep_workspace, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        body.name,
        body.description,
        repoUrl,
        body.credentialId ?? null,
        body.defaultBranch,
        body.buildEnabled ? 1 : 0,
        body.buildCommand?.trim() ?? null,
        body.targetRuntime?.trim() || null,
        body.artifactPath,
        JSON.stringify(body.excludePatterns),
        body.buildTimeoutSec,
        body.deployTimeoutSec,
        body.onTargetFailure,
        body.keepWorkspace ? 1 : 0,
        user.id,
        now,
        now,
      );
      const id = result.lastInsertRowid;
      body.targets.forEach((target, index) => {
        run(
          `INSERT INTO project_targets (project_id, server_id, remote_dir, deploy_commands, enabled, order_index)
           VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          target.serverId,
          normalizeRemoteDir(target.remoteDir),
          target.deployCommands,
          target.enabled ? 1 : 0,
          index,
        );
      });
      replaceMembers(id, body.memberIds ?? []);
      return id;
    });
    invalidateBranchCache();
    reply.code(201);
    return { project: projectDetail(loadProject(projectId)) };
  });

  app.post('/:id/copy', async (req, reply) => {
    const user = requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const source = loadProject(id);
    const body = copyProjectSchema.parse(req.body ?? {});

    let name = body.name?.trim();
    if (!name) {
      const base = `${source.name} 副本`;
      name = base;
      let suffix = 2;
      while (get<{ id: number }>('SELECT id FROM projects WHERE name = ?', name)) {
        name = `${base} ${suffix}`;
        suffix += 1;
      }
    }

    const sourceTargets = all<TargetRow>(
      'SELECT * FROM project_targets WHERE project_id = ? ORDER BY order_index ASC, id ASC',
      id,
    );
    const sourceMembers = all<{ user_id: number }>('SELECT user_id FROM project_members WHERE project_id = ?', id);
    const now = nowIso();

    const newProjectId = tx(() => {
      const result = run(
        `INSERT INTO projects (name, description, repo_url, credential_id, default_branch, build_enabled,
          build_command, target_runtime, artifact_path, exclude_patterns, build_timeout_sec, deploy_timeout_sec,
          on_target_failure, keep_workspace, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        name,
        source.description,
        source.repo_url,
        source.credential_id,
        source.default_branch,
        source.build_enabled,
        source.build_command,
        source.target_runtime,
        source.artifact_path,
        source.exclude_patterns,
        source.build_timeout_sec,
        source.deploy_timeout_sec,
        source.on_target_failure,
        source.keep_workspace,
        user.id,
        now,
        now,
      );
      const newId = result.lastInsertRowid;
      for (const target of sourceTargets) {
        run(
          `INSERT INTO project_targets (project_id, server_id, remote_dir, deploy_commands, enabled, order_index)
           VALUES (?, ?, ?, ?, ?, ?)`,
          newId,
          target.server_id,
          target.remote_dir,
          target.deploy_commands,
          target.enabled,
          target.order_index,
        );
      }
      for (const member of sourceMembers) {
        run('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)', newId, member.user_id);
      }
      return newId;
    });

    invalidateBranchCache();
    reply.code(201);
    return { project: projectDetail(loadProject(newProjectId)) };
  });

  app.get('/:id', async (req) => {
    const user = currentUser(req);
    const id = Number((req.params as { id: string }).id);
    const project = assertProjectAccess(user, id);
    return { project: projectDetail(project) };
  });

  app.patch('/:id', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const project = loadProject(id);
    const body = projectSchema.parse(req.body);
    const repoUrl = normalizeRepoUrl(body.repoUrl);
    if (!isValidBranchName(body.defaultBranch)) throw badRequest('默认分支名不合法');
    if (body.buildEnabled && !body.buildCommand?.trim()) throw badRequest('启用构建时必须填写构建命令');
    assertArtifactPath(body.artifactPath);
    validateTargets(body.targets);
    validateCredential(body.credentialId ?? null);

    tx(() => {
      run(
        `UPDATE projects SET name = ?, description = ?, repo_url = ?, credential_id = ?, default_branch = ?,
          build_enabled = ?, build_command = ?, target_runtime = ?, artifact_path = ?, exclude_patterns = ?,
          build_timeout_sec = ?, deploy_timeout_sec = ?, on_target_failure = ?, keep_workspace = ?, updated_at = ?
         WHERE id = ?`,
        body.name,
        body.description,
        repoUrl,
        body.credentialId ?? null,
        body.defaultBranch,
        body.buildEnabled ? 1 : 0,
        body.buildCommand?.trim() ?? null,
        body.targetRuntime?.trim() || null,
        body.artifactPath,
        JSON.stringify(body.excludePatterns),
        body.buildTimeoutSec,
        body.deployTimeoutSec,
        body.onTargetFailure,
        body.keepWorkspace ? 1 : 0,
        nowIso(),
        id,
      );
      run('DELETE FROM project_targets WHERE project_id = ?', id);
      body.targets.forEach((target, index) => {
        run(
          `INSERT INTO project_targets (project_id, server_id, remote_dir, deploy_commands, enabled, order_index)
           VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          target.serverId,
          normalizeRemoteDir(target.remoteDir),
          target.deployCommands,
          target.enabled ? 1 : 0,
          index,
        );
      });
      if (body.memberIds) replaceMembers(id, body.memberIds);
    });
    invalidateBranchCache(id);
    return { project: projectDetail(loadProject(id)) };
  });

  app.put('/:id/members', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    loadProject(id);
    const body = membersSchema.parse(req.body);
    tx(() => replaceMembers(id, body.userIds));
    return { project: projectDetail(loadProject(id)) };
  });

  app.delete('/:id', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const project = loadProject(id);
    const active = get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM builds WHERE project_id = ? AND status IN ('queued', 'running')",
      id,
    );
    if (Number(active?.c ?? 0) > 0) throw conflict('项目还有排队中或执行中的发布，请先取消后再删除');
    const builds = all<{ id: number }>('SELECT id FROM builds WHERE project_id = ?', id);
    run('DELETE FROM projects WHERE id = ?', id);
    invalidateBranchCache(id);
    await Promise.all(
      builds.map((build) => fs.rm(path.join(paths.logs, `${build.id}.log`), { force: true }).catch(() => undefined)),
    );
    await fs.rm(path.join(paths.workspaces, `p-${project.id}`), { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(path.join(paths.gitCache, `p-${project.id}.git`), { recursive: true, force: true }).catch(() => undefined);
    return { ok: true };
  });

  app.post('/preview-branches', async (req) => {
    requireAdmin(req);
    const body = previewBranchesSchema.parse(req.body);
    const repoUrl = normalizeRepoUrl(body.repoUrl);
    let credential: CredentialRow | null = null;
    if (body.credentialId) {
      credential = get<CredentialRow>('SELECT * FROM git_credentials WHERE id = ?', body.credentialId) ?? null;
      if (!credential) throw badRequest('Git 凭据不存在');
    }
    const started = Date.now();
    const branches = await listBranches(repoUrl, gitAuth(credential), { timeoutMs: 60_000 });
    return { branches, elapsedMs: Date.now() - started };
  });

  app.get('/:id/branches', async (req) => {
    const user = currentUser(req);
    const id = Number((req.params as { id: string }).id);
    const project = assertProjectAccess(user, id);
    const refresh = String((req.query as { refresh?: string }).refresh ?? '') === '1';
    const cached = branchCache.get(id);
    if (!refresh && cached && Date.now() - cached.at < 60_000) {
      return { branches: cached.branches, defaultBranch: project.default_branch, cached: true };
    }
    const { credential } = projectContext(project);
    const branches = await listBranches(project.repo_url, gitAuth(credential), { timeoutMs: 60_000 });
    branchCache.set(id, { at: Date.now(), branches });
    return { branches, defaultBranch: project.default_branch, cached: false };
  });

  app.post('/:id/verify-repo', async (req) => {
    requireAdmin(req);
    const id = Number((req.params as { id: string }).id);
    const project = loadProject(id);
    const started = Date.now();
    const { credential } = projectContext(project);
    const branches = await listBranches(project.repo_url, gitAuth(credential), { timeoutMs: 60_000 });
    branchCache.set(id, { at: Date.now(), branches });
    return { ok: true, branchCount: branches.length, elapsedMs: Date.now() - started, branches: branches.slice(0, 100) };
  });
}
