import type { FastifyInstance } from 'fastify';
import { all, get } from '../db.js';
import { config } from '../config.js';
import { currentUser } from '../auth/plugin.js';
import { scheduler } from '../pipeline/scheduler.js';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    ok: true,
    name: 'myJenkins',
    version: config.version,
    time: new Date().toISOString(),
  }));

  app.get('/system/info', async (req) => {
    const user = currentUser(req);
    const counts = {
      users: Number(get<{ c: number }>('SELECT COUNT(*) AS c FROM users')?.c ?? 0),
      projects:
        user.role === 'admin'
          ? Number(get<{ c: number }>('SELECT COUNT(*) AS c FROM projects')?.c ?? 0)
          : Number(
              get<{ c: number }>(
                'SELECT COUNT(*) AS c FROM project_members WHERE user_id = ?',
                user.id,
              )?.c ?? 0,
            ),
      buildsToday: Number(
        get<{ c: number }>("SELECT COUNT(*) AS c FROM builds WHERE created_at >= date('now')")?.c ?? 0,
      ),
    };
    return {
      version: config.version,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      dataDir: config.dataDir,
      logMaxBytes: config.logMaxBytes,
      logRetentionDays: config.logRetentionDays,
      counts,
      queue: scheduler.info(),
    };
  });

  app.get('/dashboard/recent', async (req) => {
    const user = currentUser(req);
    const params: Array<string | number> = [];
    let where = '';
    if (user.role !== 'admin') {
      where = 'WHERE b.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)';
      params.push(user.id);
    }
    const builds = all<{
      id: number;
      number: number;
      project_id: number;
      project_name: string;
      branch: string;
      status: string;
      commit_sha: string | null;
      created_at: string;
      finished_at: string | null;
      duration_ms: number | null;
      triggered_by_name: string | null;
    }>(
      `SELECT b.id, b.number, b.project_id, p.name AS project_name, b.branch, b.status, b.commit_sha,
              b.created_at, b.finished_at, b.duration_ms, u.username AS triggered_by_name
       FROM builds b JOIN projects p ON p.id = b.project_id
       LEFT JOIN users u ON u.id = b.triggered_by
       ${where}
       ORDER BY b.id DESC LIMIT 10`,
      ...params,
    );
    return {
      builds: builds.map((build) => ({
        id: build.id,
        number: build.number,
        projectId: build.project_id,
        projectName: build.project_name,
        branch: build.branch,
        status: build.status,
        commitSha: build.commit_sha,
        triggeredBy: build.triggered_by_name,
        createdAt: build.created_at,
        finishedAt: build.finished_at,
        durationMs: build.duration_ms,
      })),
    };
  });
}
