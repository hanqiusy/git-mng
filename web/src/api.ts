/**
 * 前端 API：经 Tauri invoke 调用 Rust 后端。
 * token 仅存在于 Rust 侧 db.json，前端不做任何持久化。
 */
import { invoke } from '@tauri-apps/api/core';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface GhUser {
  login: string;
  avatar_url: string;
  name: string | null;
  html_url: string;
}

export interface AccountInfo {
  id: string;
  login: string;
  avatarUrl: string;
  name: string | null;
  htmlUrl: string;
}

export interface AccountsState {
  accounts: AccountInfo[];
  activeAccountId: string | null;
  autoLogin: boolean;
  hasToken: boolean;
}

export interface RepoItem {
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  defaultBranch: string;
  updatedAt: string;
  url: string;
  cloned?: boolean;
  localPaths?: number;
}

export interface RepoStatus {
  state: 'clean' | 'dirty' | 'ahead' | 'behind' | 'unknown';
  branch: string | null;
  dirty: number | null;
  ahead: number | null;
  behind: number | null;
  lastCommit: string | null;
  localBranches: BranchInfo[];
  remoteBranches: BranchInfo[];
  graph: GraphCommit[];
  remoteRefreshed: boolean;
  remoteRefreshError: string | null;
}

export interface GraphCommit {
  id: string;
  shortId: string;
  parents: string[];
  date: string;
  subject: string;
  refs: string[];
}

export interface BranchInfo {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  commit: string;
  subject: string;
}

export interface ClonePath {
  path: string;
  ref: string;
  refType: 'branch' | 'tag';
  addedAt: string;
  status?: RepoStatus;
}

export interface CloneRecord {
  owner: string;
  repo: string;
  fullName: string;
  private: boolean;
  paths: ClonePath[];
}

export interface Settings {
  proxyMode: 'system' | 'custom' | 'none';
  customProxy: string;
  sslVerify: boolean;
  defaultCloneRoot: string;
  autoLogin: boolean;
}

export interface LogEntry {
  time: string;
  action: string;
  target: string;
  ok: boolean;
  detail?: string;
}

export interface DeviceStart {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

export type DevicePoll =
  | { status: 'pending' | 'slow_down'; interval: number }
  | { status: 'ok'; user: GhUser };

function tryParseApiError(raw: unknown): ApiError | null {
  if (!raw) return null;
  if (typeof raw === 'object') {
    const o = raw as { code?: string; message?: string; detail?: string };
    if (o.code && o.message) return new ApiError(o.code, o.message, o.detail);
  }
  if (typeof raw === 'string') {
    try {
      return tryParseApiError(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return null;
}

function mapInvokeError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const parsed = tryParseApiError(err);
  if (parsed) return parsed;
  if (err instanceof Error) {
    const nested = tryParseApiError(err.message);
    if (nested) return nested;
    return new ApiError('INTERNAL_ERROR', err.message);
  }
  return new ApiError('INTERNAL_ERROR', String(err));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args ?? {});
  } catch (err) {
    throw mapInvokeError(err);
  }
}

export const api = {
  deviceStart: () => call<DeviceStart>('auth_device_start'),
  devicePoll: (sessionId: string) => call<DevicePoll>('auth_device_poll', { args: { sessionId } }),
  login: (token: string) => call<{ user: GhUser }>('auth_login', { args: { token } }),
  logout: () => call<{ ok: true }>('auth_logout'),
  clearCredentials: () => call<{ ok: true }>('auth_clear_credentials'),
  listAccounts: () => call<AccountsState>('auth_list_accounts'),
  quickLogin: (accountId: string) =>
    call<{ user: GhUser }>('auth_quick_login', { args: { accountId } }),
  switchAccount: (accountId: string) =>
    call<{ user: GhUser }>('auth_switch_account', { args: { accountId } }),
  removeAccount: (accountId: string) =>
    call<{ ok: true }>('auth_remove_account', { args: { accountId } }),
  me: () => call<{ user: GhUser }>('auth_me'),

  listRepos: (visibility: 'all' | 'public' | 'private', q = '') =>
    call<{ items: RepoItem[] }>('list_repos', { args: { visibility, q } }),

  searchRepos: (q: string, sort: string, page: number) =>
    call<{ total: number; page: number; items: RepoItem[] }>('search_repos', {
      args: { q, sort, page },
    }),

  listBranches: (owner: string, repo: string) =>
    call<{ items: { name: string }[] }>('list_branches', { args: { owner, repo } }),
  listTags: (owner: string, repo: string) =>
    call<{ items: { name: string }[] }>('list_tags', { args: { owner, repo } }),

  createRepo: (name: string, description: string, isPrivate: boolean) =>
    call<{ repo: RepoItem }>('create_repo', {
      args: { name, description, private: isPrivate },
    }),
  createLinkedRepo: (name: string, description: string, isPrivate: boolean) =>
    call<{ repo: RepoItem; record: CloneRecord }>('create_linked_repo', {
      args: { name, description, private: isPrivate },
    }),

  deleteRepo: (owner: string, repo: string) =>
    call<{ ok: true }>('delete_repo', { args: { owner, repo } }),

  star: (owner: string, repo: string) =>
    call<{ ok: true }>('star_repo', { args: { owner, repo } }),
  unstar: (owner: string, repo: string) =>
    call<{ ok: true }>('unstar_repo', { args: { owner, repo } }),

  listClones: () => call<{ items: CloneRecord[] }>('list_clones'),
  refreshCloneStatus: (path: string) =>
    call<{ status: RepoStatus }>('refresh_clone_status', { args: { path } }),
  clone: (opts: {
    owner: string;
    repo: string;
    path: string;
    ref: string;
    refType: 'branch' | 'tag';
    shallow: boolean;
    private?: boolean;
  }) => call<{ record: CloneRecord }>('clone_repo', { args: opts }),
  linkLocalFolder: (opts: {
    owner: string;
    repo: string;
    path: string;
    private?: boolean;
    initialize: boolean;
  }) => call<{ record: CloneRecord }>('link_local_folder', { args: opts }),
  deleteClone: (path: string) => call<{ ok: true }>('delete_clone', { args: { path } }),
  reclone: (path: string) => call<{ ok: true }>('reclone', { args: { path } }),
  push: (path: string) => call<{ ok: true }>('push_repo', { args: { path } }),
  pull: (path: string) => call<{ ok: true }>('pull_repo', { args: { path } }),
  openDir: (path: string) => call<{ ok: true }>('open_dir', { args: { path } }),

  getSettings: () => call<{ settings: Settings }>('get_settings'),
  updateSettings: (patch: Partial<Settings>) =>
    call<{ settings: Settings }>('update_settings', { patch }),

  getLogs: () => call<{ logs: LogEntry[] }>('get_logs'),
};
