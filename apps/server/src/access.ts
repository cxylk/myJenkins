import { get } from './db.js';
import type { AuthUser } from './auth/session.js';
import type { ProjectRow } from './models.js';
import { forbidden, notFound } from './lib/errors.js';

export function loadProject(projectId: number): ProjectRow {
  const project = get<ProjectRow>('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) throw notFound('项目不存在');
  return project;
}

export function canAccessProject(user: AuthUser, projectId: number): boolean {
  if (user.role === 'admin') return true;
  return Boolean(
    get<{ project_id: number }>('SELECT project_id FROM project_members WHERE project_id = ? AND user_id = ?', projectId, user.id),
  );
}

export function assertProjectAccess(user: AuthUser, projectId: number): ProjectRow {
  const project = loadProject(projectId);
  if (!canAccessProject(user, projectId)) throw forbidden('没有该项目的访问权限');
  return project;
}

export function canManageProject(user: AuthUser): boolean {
  return user.role === 'admin';
}
