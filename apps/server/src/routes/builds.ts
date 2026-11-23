import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { all, get, nowIso, run, tx } from '../db.js';
import { config, paths } from '../config.js';
import type { BuildRow, BuildTargetRow, ProjectRow } from '../models.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isValidBranchName } from '../git.js';
import { currentUser } from '../auth/plugin.js';
import { assertProjectAccess, canAccessProject } from '../access.js';
import { findSession } from '../auth/session.js';
import { scheduler } from '../pipeline/scheduler.js';
import { readNewLog } from '../pipeline/log.js';

const createBuildSchema = z.object({
  branch: z.string().trim().min(1, '请选择分支').max(200),
});

const listQuerySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  beforeId: z.coerce.number().int().positive().optional(),
});

interface BuildListRow extends BuildRow {
  project_name: string;
  triggered_by_name: string | null;
}

interface BuildDetailRow extends BuildListRow {
  project_description: string;
}

function loadBuild(buildId: number): BuildRow {
  const build = get<BuildRow>('SELECT * FROM builds WHERE id = ?', buildId);
  if (!build) throw notFound('发布记录不存在');
  return build;
}

function loadBuildDetail(buildId: number): BuildDetailRow {
  const row = get<BuildDetailRow>(
    `SELECT b.*, p.name AS project_name, p.description AS project_description, u.username AS triggered_by_name
     FROM builds b
     JOIN projects p ON p.id = b.project_id
     LEFT JOIN users u ON u.id = b.triggered_by
     WHERE b.id = ?`,
    buildId,
  );
  if (!row) throw notFound('发布记录不存在');
  return row;
}

function buildTargets(buildId: number) {
  return all<BuildTargetRow>('SELECT * FROM build_targets WHERE build_id = ? ORDER BY id ASC', buildId).map((row) => ({
    id: row.id,
    targetId: row.target_id,
    serverId: row.server_id,
    serverName: row.server_name,
    remoteDir: row.remote_dir,
    deployCommands: row.deploy_commands,
    status: row.status,
    filesUploaded: row.files_uploaded,
    bytesUploaded: row.bytes_uploaded,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  }));
}

function buildDto(row: BuildListRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    number: row.number,
    branch: row.branch,
    commitSha: row.commit_sha,
    commitSubject: row.commit_subject,
    status: row.status,
    triggerType: row.trigger_type,
    triggeredBy: row.triggered_by_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    error: row.error,
    logSize: row.log_size,
    createdAt: row.created_at,
    canCancel: row.status === 'queued' || row.status === 'running',
    targets: buildTargets(row.id),
  };
}

function accessBuild(req: Parameters<typeof currentUser>[0], buildId: number): BuildRow {
  const user = currentUser(req);
  const build = loadBuild(buildId);
  assertProjectAccess(user, build.project_id);
  return build;
}

export async function buildRoutes(app: FastifyInstance): Promise<void> {
  app.post('/projects/:projectId/builds', async (req, reply) => {
    const user = currentUser(req);
    const projectId = Number((req.params as { projectId: string }).projectId);
    const project: ProjectRow = assertProjectAccess(user, projectId);
    const body = createBuildSchema.parse(req.body);
    if (!isValidBranchName(body.branch)) throw badRequest('分支名不合法');
    if (project.build_enabled === 1 && !(project.build_command ?? '').trim()) {
      throw badRequest('项目启用了构建但没有配置构建命令，请联系管理员完善项目配置');
    }

    const targets = all<{
      id: number;
      server_id: number;
      remote_dir: string;
      deploy_commands: string;
      server_name: string;
    }>(
      `SELECT t.id, t.server_id, t.remote_dir, t.deploy_commands, s.name AS server_name
       FROM project_targets t JOIN servers s ON s.id = t.server_id
       WHERE t.project_id = ? AND t.enabled = 1
       ORDER BY t.order_index ASC, t.id ASC`,
      projectId,
    );
    if (targets.length === 0) throw badRequest('项目没有启用中的发布目标，无法发布');

    const now = nowIso();
    const buildId = tx(() => {
      const max = get<{ m: number | null }>('SELECT MAX(number) AS m FROM builds WHERE project_id = ?', projectId);
      const number = Number(max?.m ?? 0) + 1;
      const result = run(
        `INSERT INTO builds (project_id, number, branch, status, triggered_by, trigger_type, created_at)
         VALUES (?, ?, ?, 'queued', ?, 'manual', ?)`,
        projectId,
        number,
        body.branch,
        user.id,
        now,
      );
      for (const target of targets) {
        run(
          `INSERT INTO build_targets (build_id, target_id, server_id, server_name, remote_dir, deploy_commands, status)
           VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
          result.lastInsertRowid,
          target.id,
          target.server_id,
          target.server_name,
          target.remote_dir,
          target.deploy_commands,
        );
      }
      return result.lastInsertRowid;
    });

    scheduler.enqueue(buildId, projectId);
    reply.code(201);
    return { build: buildDto(loadBuildDetail(buildId)) };
  });

  app.get('/builds', async (req) => {
    const user = currentUser(req);
    const query = listQuerySchema.parse(req.query ?? {});
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (query.projectId) {
      const project = assertProjectAccess(user, query.projectId);
      conditions.push('b.project_id = ?');
      params.push(project.id);
    } else if (user.role !== 'admin') {
      conditions.push('b.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)');
      params.push(user.id);
    }
    if (query.status) {
      conditions.push('b.status = ?');
      params.push(query.status);
    }
    if (query.beforeId) {
      conditions.push('b.id < ?');
      params.push(query.beforeId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = all<BuildListRow>(
      `SELECT b.*, p.name AS project_name, u.username AS triggered_by_name
       FROM builds b JOIN projects p ON p.id = b.project_id
       LEFT JOIN users u ON u.id = b.triggered_by
       ${where}
       ORDER BY b.id DESC LIMIT ?`,
      ...params,
      query.limit,
    );
    return {
      builds: rows.map((row) => buildDto(row)),
      nextCursor: rows.length === query.limit ? rows[rows.length - 1].id : null,
    };
  });

  app.get('/builds/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const build = accessBuild(req, id);
    void build;
    const detail = loadBuildDetail(id);
    return {
      build: {
        ...buildDto(detail),
        projectDescription: detail.project_description,
        logEndpoint: `/api/builds/${id}/events`,
      },
    };
  });

  app.get('/builds/:id/log', async (req) => {
    const id = Number((req.params as { id: string }).id);
    accessBuild(req, id);
    const query = z
      .object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(512 * 1024).default(256 * 1024),
      })
      .parse(req.query ?? {});
    const filePath = path.join(paths.logs, `${id}.log`);
    const chunk = await readNewLog(filePath, query.offset, query.limit);
    const build = loadBuild(id);
    return {
      content: chunk.text,
      offset: chunk.nextOffset,
      size: chunk.size,
      status: build.status,
      running: build.status === 'queued' || build.status === 'running',
    };
  });

  app.get('/builds/:id/log/download', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    accessBuild(req, id);
    const build = loadBuildDetail(id);
    const filePath = path.join(paths.logs, `${id}.log`);
    if (!fs.existsSync(filePath)) throw notFound('该发布还没有日志');
    reply
      .header('Content-Disposition', `attachment; filename="build-${build.number}.log"`)
      .type('text/plain; charset=utf-8');
    return reply.send(fs.createReadStream(filePath));
  });

  app.get('/builds/:id/events', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const buildRow = accessBuild(req, id);
    const sessionToken = req.sessionToken;
    const filePath = path.join(paths.logs, `${id}.log`);
    const rawQuery = req.query as { offset?: string } | undefined;
    const headerOffset = req.headers['last-event-id'];
    const rawOffset = Array.isArray(headerOffset) ? headerOffset[0] : headerOffset ?? rawQuery?.offset ?? '0';
    let offset = Number.parseInt(String(rawOffset), 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 2000\n\n');

    let closed = false;
    let timer: NodeJS.Timeout | null = null;
    const heartbeat = setInterval(() => {
      if (!closed) raw.write(': ping\n\n');
    }, 15_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(heartbeat);
      req.raw.off('close', cleanup);
    };

    req.raw.on('close', cleanup);
    let lastAuthCheck = Date.now();

    const tick = async () => {
      if (closed) return;
      try {
        const chunk = await readNewLog(filePath, offset, 256 * 1024);
        if (chunk.nextOffset > offset) {
          offset = chunk.nextOffset;
          raw.write(`id: ${offset}\ndata: ${JSON.stringify({ offset: chunk.nextOffset, text: chunk.text })}\n\n`);
        }
        if (Date.now() - lastAuthCheck > 5000) {
          lastAuthCheck = Date.now();
          const session = sessionToken ? findSession(sessionToken) : null;
          if (!session || !canAccessProject(session.user, buildRow.project_id)) {
            cleanup();
            raw.end();
            return;
          }
        }
        const build = get<{ status: string }>('SELECT status FROM builds WHERE id = ?', id);
        const terminal = !build || !['queued', 'running'].includes(build.status);
        if (terminal && chunk.nextOffset >= chunk.size) {
          raw.write(`event: end\ndata: ${JSON.stringify({ status: build?.status ?? 'failed' })}\n\n`);
          cleanup();
          raw.end();
          return;
        }
      } catch {
        /* keep the stream alive; client will retry */
      }
      if (!closed) timer = setTimeout(() => void tick(), 350);
    };

    void tick();
  });

  app.post('/builds/:id/cancel', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const build = accessBuild(req, id);
    if (build.status !== 'queued' && build.status !== 'running') {
      throw badRequest('该发布已经结束，无法取消');
    }
    const result = scheduler.cancel(id);
    if (!result) throw badRequest('取消失败，请刷新后重试');
    return { ok: true, status: result };
  });
}

