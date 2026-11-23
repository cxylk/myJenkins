import fs from 'node:fs';
import path from 'node:path';
import { all, get, nowIso, run } from '../db.js';
import { config, paths } from '../config.js';
import type { BuildRow } from '../models.js';
import { executeBuild } from './runner.js';

interface QueueItem {
  buildId: number;
  projectId: number;
}

function appendLogLine(buildId: number, line: string): void {
  try {
    fs.mkdirSync(paths.logs, { recursive: true });
    fs.appendFileSync(path.join(paths.logs, `${buildId}.log`), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* ignore */
  }
}

export class Scheduler {
  private queue: QueueItem[] = [];
  private active = new Map<number, AbortController>();
  private projectLocks = new Set<number>();
  private started = false;
  private pumpTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  async init(): Promise<void> {
    const now = nowIso();
    const interrupted = all<{ id: number }>("SELECT id FROM builds WHERE status = 'running'");
    for (const build of interrupted) {
      run("UPDATE builds SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", now, '服务重启，发布被中断', build.id);
      run(
        `UPDATE build_targets SET status = 'failed', finished_at = ?, error = COALESCE(error, '服务重启，发布被中断')
         WHERE build_id = ? AND status IN ('queued', 'running')`,
        now,
        build.id,
      );
      appendLogLine(build.id, '[错误] 服务重启，发布被中断');
    }

    const queued = all<{ id: number; project_id: number }>(
      "SELECT id, project_id FROM builds WHERE status = 'queued' ORDER BY id ASC",
    );
    this.queue = queued.map((row) => ({ buildId: row.id, projectId: row.project_id }));
    this.started = true;
    this.pump();
    this.pumpTimer = setInterval(() => this.pump(), 2000);
    await this.cleanup();
    this.cleanupTimer = setInterval(() => void this.cleanup(), 6 * 60 * 60 * 1000);
    this.pumpTimer.unref();
    this.cleanupTimer.unref();
  }

  enqueue(buildId: number, projectId: number): void {
    if (!this.started) return;
    this.queue.push({ buildId, projectId });
    this.pump();
  }

  cancel(buildId: number): 'queued' | 'running' | null {
    const build = get<BuildRow>('SELECT * FROM builds WHERE id = ?', buildId);
    if (!build) return null;
    if (build.status === 'queued') {
      this.queue = this.queue.filter((item) => item.buildId !== buildId);
      const now = nowIso();
      const updated = run(
        "UPDATE builds SET status = 'cancelled', finished_at = ?, error = '发布在排队时被取消' WHERE id = ? AND status = 'queued'",
        now,
        buildId,
      );
      if (updated.changes === 0) return null;
      run(
        `UPDATE build_targets SET status = 'cancelled', finished_at = ?, error = '发布在排队时被取消'
         WHERE build_id = ? AND status IN ('queued', 'running')`,
        now,
        buildId,
      );
      appendLogLine(buildId, '[错误] 发布在排队时被取消');
      return 'queued';
    }
    if (build.status === 'running') {
      const controller = this.active.get(buildId);
      if (!controller) return null;
      controller.abort();
      return 'running';
    }
    return null;
  }

  info(): { active: number; queued: number; maxConcurrency: number } {
    return { active: this.active.size, queued: this.queue.length, maxConcurrency: config.maxConcurrency };
  }

  async shutdown(): Promise<void> {
    this.started = false;
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.pumpTimer = null;
    this.cleanupTimer = null;
    for (const controller of this.active.values()) controller.abort();
    if (this.active.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  private pump(): void {
    if (!this.started) return;
    while (this.active.size < config.maxConcurrency) {
      const index = this.queue.findIndex((item) => !this.projectLocks.has(item.projectId));
      if (index === -1) return;
      const [item] = this.queue.splice(index, 1);
      this.launch(item);
    }
  }

  private launch(item: QueueItem): void {
    const current = get<{ status: string }>('SELECT status FROM builds WHERE id = ?', item.buildId);
    if (!current || current.status !== 'queued') {
      this.pump();
      return;
    }
    const controller = new AbortController();
    this.active.set(item.buildId, controller);
    this.projectLocks.add(item.projectId);
    const watchdog = setTimeout(() => {
      controller.abort('timeout');
    }, config.maxBuildMinutes * 60_000);
    watchdog.unref();

    executeBuild(item.buildId, controller.signal)
      .catch((error: unknown) => {
        const row = get<{ status: string }>('SELECT status FROM builds WHERE id = ?', item.buildId);
        if (!row || (row.status !== 'running' && row.status !== 'queued')) return;
        const message = error instanceof Error ? error.message : String(error);
        const now = nowIso();
        run(
          "UPDATE builds SET status = 'failed', finished_at = ?, error = ? WHERE id = ?",
          now,
          `发布执行器异常：${message}`.slice(0, 2000),
          item.buildId,
        );
        run(
          `UPDATE build_targets SET status = 'failed', finished_at = ?, error = COALESCE(error, ?)
           WHERE build_id = ? AND status IN ('queued', 'running')`,
          now,
          `发布执行器异常：${message}`.slice(0, 1000),
          item.buildId,
        );
        appendLogLine(item.buildId, `[错误] 发布执行器异常：${message}`);
      })
      .finally(() => {
        clearTimeout(watchdog);
        this.active.delete(item.buildId);
        this.projectLocks.delete(item.projectId);
        this.pump();
      });
  }

  async cleanup(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - config.logRetentionDays * 86_400_000).toISOString();
      const expired = all<{ id: number }>(
        'SELECT id FROM builds WHERE created_at < ? AND log_size > 0 LIMIT 500',
        cutoff,
      );
      for (const build of expired) {
        await fs.promises.rm(path.join(paths.logs, `${build.id}.log`), { force: true }).catch(() => undefined);
        run('UPDATE builds SET log_size = 0 WHERE id = ?', build.id);
      }
      run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
      await this.cleanupWorkspaces();
    } catch {
      /* cleanup is best effort */
    }
  }

  private async cleanupWorkspaces(): Promise<void> {
    const retention = 7 * 86_400_000;
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = await fs.promises.readdir(paths.workspaces, { withFileTypes: true });
    } catch {
      return;
    }
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = path.join(paths.workspaces, projectDir.name);
      let buildDirs: fs.Dirent[];
      try {
        buildDirs = await fs.promises.readdir(projectPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const buildDir of buildDirs) {
        if (!buildDir.isDirectory()) continue;
        const target = path.join(projectPath, buildDir.name);
        try {
          const stat = await fs.promises.stat(target);
          if (Date.now() - stat.mtimeMs > retention) await fs.promises.rm(target, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      const rest = await fs.promises.readdir(projectPath).catch(() => ['x']);
      if (rest.length === 0) await fs.promises.rmdir(projectPath).catch(() => undefined);
    }
  }
}

export const scheduler = new Scheduler();
