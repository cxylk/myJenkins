export type BuildStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type TargetStatus = 'queued' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';

export interface User {
  id: number;
  username: string;
  role: 'admin' | 'member';
  displayName: string | null;
  disabled?: boolean;
  projectCount?: number;
  createdAt?: string;
}

export interface Credential {
  id: number;
  name: string;
  authType: 'https_token' | 'ssh_key';
  username: string | null;
  hasSecret: boolean;
  hasPassphrase: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServerInfo {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'private_key';
  fingerprint: string | null;
  trusted: boolean;
  trustedAt: string | null;
  usedByProjects: number;
  hasPassphrase: boolean;
  createdAt: string;
}

export interface TestResult {
  ok: boolean;
  fingerprint?: string;
  system?: string;
  error?: string;
  elapsedMs: number;
  trusted?: boolean;
  changed?: boolean;
}

export interface TargetInfo {
  id: number;
  serverId: number;
  serverName: string;
  host: string;
  port: number;
  username: string;
  remoteDir: string;
  deployCommands: string;
  enabled: boolean;
  orderIndex: number;
}

export interface BuildSummary {
  id: number;
  projectId: number;
  projectName?: string;
  number: number;
  branch: string;
  commitSha: string | null;
  commitSubject?: string | null;
  status: BuildStatus;
  triggeredBy?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  error?: string | null;
  logSize?: number;
  canCancel?: boolean;
}

export interface ProjectSummary {
  id: number;
  name: string;
  description: string;
  repoUrl: string;
  defaultBranch: string;
  credentialName: string | null;
  buildEnabled: boolean;
  targetCount: number;
  createdAt: string;
  lastBuild: BuildSummary | null;
}

export interface Project extends ProjectSummary {
  credentialId: number | null;
  buildCommand: string | null;
  targetRuntime: string | null;
  artifactPath: string;
  excludePatterns: string[];
  buildTimeoutSec: number;
  deployTimeoutSec: number;
  onTargetFailure: 'abort' | 'continue';
  keepWorkspace: boolean;
  updatedAt: string;
  targets: TargetInfo[];
  members: User[];
}

export interface BuildTarget {
  id: number;
  targetId: number | null;
  serverId: number | null;
  serverName: string;
  remoteDir: string;
  deployCommands: string;
  status: TargetStatus;
  filesUploaded: number;
  bytesUploaded: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface Build extends BuildSummary {
  targets: BuildTarget[];
  projectDescription?: string;
  logEndpoint?: string;
}

export interface RecentBuild {
  id: number;
  number: number;
  projectId: number;
  projectName: string;
  branch: string;
  status: BuildStatus;
  commitSha: string | null;
  triggeredBy: string | null;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface SystemInfo {
  version: string;
  node: string;
  uptimeSec: number;
  dataDir: string;
  logMaxBytes: number;
  logRetentionDays: number;
  counts: { users: number; projects: number; buildsToday: number };
  queue: { active: number; queued: number; maxConcurrency: number };
}

export interface BuildLogChunk {
  content: string;
  offset: number;
  size: number;
  status: BuildStatus;
  running: boolean;
}
