export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'member';
  display_name: string | null;
  disabled: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  token_hash: string;
  user_id: number;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface CredentialRow {
  id: number;
  name: string;
  auth_type: 'https_token' | 'ssh_key';
  username: string | null;
  secret_enc: string;
  passphrase_enc: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: 'password' | 'private_key';
  secret_enc: string;
  passphrase_enc: string | null;
  host_key_fingerprint: string | null;
  trusted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: number;
  name: string;
  description: string;
  repo_url: string;
  credential_id: number | null;
  default_branch: string;
  build_enabled: number;
  build_command: string | null;
  target_runtime: string | null;
  artifact_path: string;
  exclude_patterns: string;
  build_timeout_sec: number;
  deploy_timeout_sec: number;
  on_target_failure: 'abort' | 'continue';
  keep_workspace: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface TargetRow {
  id: number;
  project_id: number;
  server_id: number;
  remote_dir: string;
  deploy_commands: string;
  enabled: number;
  order_index: number;
}

export type BuildStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type TargetStatus = 'queued' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';

export interface BuildRow {
  id: number;
  project_id: number;
  number: number;
  branch: string;
  commit_sha: string | null;
  commit_subject: string | null;
  status: BuildStatus;
  triggered_by: number | null;
  trigger_type: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  log_size: number;
  created_at: string;
}

export interface BuildTargetRow {
  id: number;
  build_id: number;
  target_id: number | null;
  server_id: number | null;
  server_name: string;
  remote_dir: string;
  deploy_commands: string;
  status: TargetStatus;
  files_uploaded: number;
  bytes_uploaded: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}
