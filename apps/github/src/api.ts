import { invoke } from '@bundled/yaar';
import type {
  RateLimit, Repo, Issue, Comment, Pull, CommitItem, Release, ContentEntry, GHUser, AccountRepo,
} from './types';
import { state, setState } from './store';

const API = 'https://api.github.com';

export interface GHResponse<T> {
  ok: boolean;
  status: number;
  data: T;
  body: string;
}

interface RawHttp {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}

function buildHeaders(withJsonBody: boolean): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = state.token.trim();
  if (token) h.Authorization = `Bearer ${token}`;
  if (withJsonBody) h['Content-Type'] = 'application/json';
  return h;
}

function extractRateLimit(headers?: Record<string, string>): RateLimit | null {
  if (!headers) return null;
  const lim = headers['x-ratelimit-limit'];
  if (lim == null) return null;
  return {
    limit: Number(lim) || 0,
    remaining: Number(headers['x-ratelimit-remaining']) || 0,
    reset: Number(headers['x-ratelimit-reset']) || 0,
    used: Number(headers['x-ratelimit-used']) || 0,
  };
}

export interface RequestOpts {
  method?: string;
  body?: unknown;
}

async function gh<T = unknown>(path: string, opts: RequestOpts = {}): Promise<GHResponse<T>> {
  const method = opts.method || 'GET';
  const hasBody = opts.body !== undefined;
  const headers = buildHeaders(hasBody);
  const url = path.startsWith('http') ? path : API + path;
  const res = (await invoke('yaar://http', {
    url,
    method,
    headers,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  })) as RawHttp;

  const rate = extractRateLimit(res.headers);
  if (rate) setState('rateLimit', rate);

  let data: unknown = null;
  const bodyStr = res.body || '';
  if (bodyStr) {
    try { data = JSON.parse(bodyStr); } catch { data = bodyStr; }
  }

  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message || `GitHub error ${res.status}`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  return { ok: res.ok, status: res.status, data: data as T, body: bodyStr };
}

const slug = () => `${state.repo.owner}/${state.repo.name}`;

// ── Authenticated user ──────────────────────────────────────────────────────
export async function fetchUser(): Promise<GHUser> {
  return (await gh<GHUser>('/user')).data;
}

/** Repositories visible to the signed-in account, including private and org repos. */
export async function fetchUserRepos(): Promise<AccountRepo[]> {
  const repos: AccountRepo[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = (await gh<AccountRepo[]>(`/user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=updated&direction=desc&per_page=100&page=${page}`)).data || [];
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

// ── Repo / overview ─────────────────────────────────────────────────────────
export async function fetchRepo(): Promise<Repo> {
  return (await gh<Repo>(`/repos/${slug()}`)).data;
}

export async function fetchReadme(): Promise<{ content: string; encoding: string } | null> {
  try {
    const res = await gh<{ content: string; encoding: string }>(`/repos/${slug()}/readme`);
    return res.data;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

// ── Issues ──────────────────────────────────────────────────────────────────
export async function fetchIssues(issueState: 'open' | 'closed'): Promise<Issue[]> {
  const res = await gh<Issue[]>(`/repos/${slug()}/issues?state=${issueState}&per_page=50&sort=updated`);
  // The issues endpoint also returns PRs; filter them out.
  return (res.data || []).filter((i) => !i.pull_request);
}

export async function fetchIssue(number: number): Promise<Issue> {
  return (await gh<Issue>(`/repos/${slug()}/issues/${number}`)).data;
}

export async function fetchIssueComments(number: number): Promise<Comment[]> {
  return (await gh<Comment[]>(`/repos/${slug()}/issues/${number}/comments?per_page=100`)).data || [];
}

export async function createIssue(title: string, body: string): Promise<Issue> {
  return (await gh<Issue>(`/repos/${slug()}/issues`, { method: 'POST', body: { title, body } })).data;
}

export async function createComment(number: number, body: string): Promise<Comment> {
  return (await gh<Comment>(`/repos/${slug()}/issues/${number}/comments`, { method: 'POST', body: { body } })).data;
}

export async function setIssueState(number: number, issueState: 'open' | 'closed'): Promise<Issue> {
  return (await gh<Issue>(`/repos/${slug()}/issues/${number}`, { method: 'PATCH', body: { state: issueState } })).data;
}

// ── Pull requests ───────────────────────────────────────────────────────────
export async function fetchPulls(prState: 'open' | 'closed'): Promise<Pull[]> {
  return (await gh<Pull[]>(`/repos/${slug()}/pulls?state=${prState}&per_page=50&sort=updated&direction=desc`)).data || [];
}

export async function fetchPull(number: number): Promise<Pull> {
  return (await gh<Pull>(`/repos/${slug()}/pulls/${number}`)).data;
}

export async function fetchPullCommits(number: number): Promise<CommitItem[]> {
  return (await gh<CommitItem[]>(`/repos/${slug()}/pulls/${number}/commits?per_page=100`)).data || [];
}

export async function fetchPullComments(number: number): Promise<Comment[]> {
  // PR conversation comments live on the issue comments endpoint.
  return (await gh<Comment[]>(`/repos/${slug()}/issues/${number}/comments?per_page=100`)).data || [];
}

// ── Releases ────────────────────────────────────────────────────────────────
export async function fetchReleases(): Promise<Release[]> {
  return (await gh<Release[]>(`/repos/${slug()}/releases?per_page=50`)).data || [];
}

// ── Code / contents ─────────────────────────────────────────────────────────
export async function fetchContents(path: string): Promise<ContentEntry[] | ContentEntry> {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const res = await gh<ContentEntry[] | ContentEntry>(`/repos/${slug()}/contents/${clean}`);
  return res.data;
}

export async function fetchFileContent(path: string): Promise<{ content: string; encoding: string; size: number; name: string; download_url: string | null }> {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const res = await gh<{ content: string; encoding: string; size: number; name: string; download_url: string | null }>(`/repos/${slug()}/contents/${clean}`);
  return res.data;
}
