export type Section = 'overview' | 'issues' | 'pulls' | 'releases' | 'code' | 'settings';

export interface RepoRef {
  owner: string;
  name: string;
}

export interface AccountRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  archived: boolean;
  description: string | null;
  owner: { login: string; avatar_url: string };
  updated_at: string;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  reset: number;
  used: number;
}

export interface GHUser {
  login: string;
  avatar_url: string;
  html_url: string;
}

/** OAuth device-flow sign-in state. */
export interface AuthState {
  /** idle → starting (requesting a code) → pending (awaiting authorization) → authed / error */
  status: 'idle' | 'starting' | 'pending' | 'authed' | 'error';
  /** The short code the user types at github.com/login/device (while pending). */
  userCode: string;
  /** The URL the user opens to enter the code (while pending). */
  verificationUri: string;
  /** Human-readable error message (while status === 'error'). */
  error: string;
}

export interface Repo {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  subscribers_count: number;
  watchers_count: number;
  open_issues_count: number;
  default_branch: string;
  html_url: string;
  language: string | null;
  license: { name: string } | null;
  homepage: string | null;
  topics?: string[];
  updated_at: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  body: string | null;
  user: GHUser;
  labels: Label[];
  comments: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}

export interface Comment {
  id: number;
  user: GHUser;
  body: string;
  created_at: string;
}

export interface Pull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  body: string | null;
  user: GHUser;
  created_at: string;
  updated_at: string;
  html_url: string;
  merged: boolean;
  merged_at: string | null;
  changed_files?: number;
  commits?: number;
  additions?: number;
  deletions?: number;
  head: { ref: string };
  base: { ref: string };
}

export interface CommitItem {
  sha: string;
  commit: { message: string; author: { name: string; date: string } };
  author: GHUser | null;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  download_count: number;
}

export interface Release {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  created_at: string;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  author: GHUser;
  assets: ReleaseAsset[];
}

export interface ContentEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size: number;
  download_url: string | null;
}
