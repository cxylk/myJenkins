import type {
  Build,
  BuildLogChunk,
  BuildSummary,
  Credential,
  Project,
  ProjectSummary,
  RecentBuild,
  ServerInfo,
  SystemInfo,
  TestResult,
  User,
} from './types';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function notifyUnauthorized(): void {
  window.dispatchEvent(new CustomEvent('myjenkins:unauthorized'));
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers as Record<string, string>) };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { credentials: 'same-origin', ...init, headers });
  } catch {
    throw new ApiError('无法连接服务器，请检查网络或服务状态');
  }
  if (response.status === 401) notifyUnauthorized();
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const body = payload as { message?: string; code?: string } | null;
    throw new ApiError(body?.message || `请求失败（${response.status}）`, response.status, body?.code);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export const authApi = {
  me: () => api.get<{ user: User }>('/auth/me'),
  login: (username: string, password: string) => api.post<{ user: User }>('/auth/login', { username, password }),
  logout: () => api.post<{ ok: boolean }>('/auth/logout'),
  changePassword: (oldPassword: string, newPassword: string) =>
    api.put<{ ok: boolean }>('/auth/password', { oldPassword, newPassword }),
};

export interface ProjectPayload {
  name: string;
  description: string;
  repoUrl: string;
  credentialId: number | null;
  defaultBranch: string;
  buildEnabled: boolean;
  buildCommand: string | null;
  targetRuntime: string | null;
  artifactPath: string;
  excludePatterns: string[];
  buildTimeoutSec: number;
  deployTimeoutSec: number;
  onTargetFailure: 'abort' | 'continue';
  keepWorkspace: boolean;
  targets: Array<{
    id?: number;
    serverId: number;
    remoteDir: string;
    deployCommands: string;
    enabled: boolean;
  }>;
  memberIds?: number[];
}

export const projectApi = {
  list: () => api.get<{ projects: ProjectSummary[] }>('/projects'),
  get: (id: number) => api.get<{ project: Project }>(`/projects/${id}`),
  previewBranches: (repoUrl: string, credentialId: number | null) =>
    api.post<{ branches: string[]; elapsedMs: number }>('/projects/preview-branches', { repoUrl, credentialId }),
  create: (payload: ProjectPayload) => api.post<{ project: Project }>('/projects', payload),
  copy: (id: number, name: string) => api.post<{ project: Project }>(`/projects/${id}/copy`, { name }),
  update: (id: number, payload: ProjectPayload) => api.patch<{ project: Project }>(`/projects/${id}`, payload),
  remove: (id: number) => api.del<{ ok: boolean }>(`/projects/${id}`),
  updateMembers: (id: number, userIds: number[]) =>
    api.put<{ project: Project }>(`/projects/${id}/members`, { userIds }),
  branches: (id: number, refresh = false) =>
    api.get<{ branches: string[]; defaultBranch: string; cached: boolean }>(
      `/projects/${id}/branches${refresh ? '?refresh=1' : ''}`,
    ),
  verifyRepo: (id: number) =>
    api.post<{ ok: boolean; branchCount: number; elapsedMs: number; branches: string[] }>(
      `/projects/${id}/verify-repo`,
    ),
};

export const buildApi = {
  trigger: (projectId: number, branch: string) =>
    api.post<{ build: Build }>(`/projects/${projectId}/builds`, { branch }),
  list: (params: { projectId?: number; status?: string; limit?: number; beforeId?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.projectId) search.set('projectId', String(params.projectId));
    if (params.status) search.set('status', params.status);
    search.set('limit', String(params.limit ?? 20));
    if (params.beforeId) search.set('beforeId', String(params.beforeId));
    return api.get<{ builds: BuildSummary[]; nextCursor: number | null }>(`/builds?${search.toString()}`);
  },
  get: (id: number) => api.get<{ build: Build }>(`/builds/${id}`),
  log: (id: number, offset = 0, limit = 256 * 1024) =>
    api.get<BuildLogChunk>(`/builds/${id}/log?offset=${offset}&limit=${limit}`),
  cancel: (id: number) => api.post<{ ok: boolean; status: string }>(`/builds/${id}/cancel`),
  recent: () => api.get<{ builds: RecentBuild[] }>('/dashboard/recent'),
};

export const serverApi = {
  list: () => api.get<{ servers: ServerInfo[] }>('/servers'),
  create: (payload: object) => api.post<{ server: ServerInfo }>('/servers', payload),
  update: (id: number, payload: object) => api.patch<{ server: ServerInfo }>(`/servers/${id}`, payload),
  remove: (id: number) => api.del<{ ok: boolean }>(`/servers/${id}`),
  test: (id: number) => api.post<TestResult>(`/servers/${id}/test`),
  trust: (id: number, fingerprint: string) => api.post<{ ok: boolean }>(`/servers/${id}/trust`, { fingerprint }),
};

export const credentialApi = {
  list: () => api.get<{ credentials: Credential[] }>('/credentials'),
  create: (payload: object) => api.post<{ credential: Credential }>('/credentials', payload),
  update: (id: number, payload: object) =>
    api.patch<{ credential: Credential }>(`/credentials/${id}`, payload),
  remove: (id: number) => api.del<{ ok: boolean }>(`/credentials/${id}`),
};

export const userApi = {
  list: () => api.get<{ users: User[] }>('/users'),
  create: (payload: object) => api.post<{ user: User }>('/users', payload),
  update: (id: number, payload: object) => api.patch<{ user: User }>(`/users/${id}`, payload),
  remove: (id: number) => api.del<{ ok: boolean }>(`/users/${id}`),
  resetPassword: (id: number, password: string) =>
    api.post<{ ok: boolean }>(`/users/${id}/reset-password`, { password }),
};

export const systemApi = {
  info: () => api.get<SystemInfo>('/system/info'),
};
