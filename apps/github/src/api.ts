import { httpFetch, errMsg } from '@bundled/yaar';
import type {
  RateLimit, Repo, Issue, Comment, Pull, CommitItem, Release, ContentEntry, GHUser, AccountRepo,
} from './types';
import { state, setState } from './store';

const API = 'https://api.github.com';

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

function extractRateLimit(headers: Headers): RateLimit | null {
  const lim = headers.get('x-ratelimit-limit');
  if (lim == null) return null;
  return {
    limit: Number(lim) || 0,
    remaining: Number(headers.get('x-ratelimit-remaining')) || 0,
    reset: Number(headers.get('x-ratelimit-reset')) || 0,
    used: Number(headers.get('x-ratelimit-used')) || 0,
  };
}

export interface RequestOpts {
  method?: string;
  body?: unknown;
}

/**
 * One GitHub REST call. Transport is `httpFetch` (a real `fetch`); everything
 * GitHub-specific — bearer auth, rate-limit headers, `{ message }` error bodies —
 * stays here. Returns the parsed JSON payload; non-2xx throws an `Error` carrying
 * `.status` so callers can special-case 401/404.
 */
async function gh<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {
  const method = opts.method || 'GET';
  const hasBody = opts.body !== undefined;
  const headers = buildHeaders(hasBody);
  const url = path.startsWith('http') ? path : API + path;

  let res: Response;
  try {
    res = await httpFetch(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    // Transport/domain failure (offline, SSRF block, denied domain). The old verb
    // path reported these as a non-ok envelope; now they reject, so re-shape them
    // into the same Error contract callers already handle.
    throw new Error(`Could not reach GitHub: ${errMsg(e)}`);
  }

  const rate = extractRateLimit(res.headers);
  if (rate) setState('rateLimit', rate);

  // 204 No Content and empty error bodies are both legitimate; keep `null`.
  const bodyStr = await res.text();
  let data: unknown = null;
  if (bodyStr) {
    try { data = JSON.parse(bodyStr); } catch { data = bodyStr; }
  }

  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message || `GitHub error ${res.status}`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  return data as T;
}

const slug = () => `${state.repo.owner}/${state.repo.name}`;

// ── Authenticated user ──────────────────────────────────────────────────────
export async function fetchUser(): Promise<GHUser> {
  return gh<GHUser>('/user');
}

/** Repositories visible to the signed-in account, including private and org repos. */
export async function fetchUserRepos(): Promise<AccountRepo[]> {
  const repos: AccountRepo[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = (await gh<AccountRepo[]>(`/user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=updated&direction=desc&per_page=100&page=${page}`)) || [];
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

// ── Repo / overview ─────────────────────────────────────────────────────────
export async function fetchRepo(): Promise<Repo> {
  return gh<Repo>(`/repos/${slug()}`);
}

export async function fetchReadme(): Promise<{ content: string; encoding: string } | null> {
  try {
    return await gh<{ content: string; encoding: string }>(`/repos/${slug()}/readme`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

// ── Issues ──────────────────────────────────────────────────────────────────
export async function fetchIssues(issueState: 'open' | 'closed'): Promise<Issue[]> {
  const issues = await gh<Issue[]>(`/repos/${slug()}/issues?state=${issueState}&per_page=50&sort=updated`);
  // The issues endpoint also returns PRs; filter them out.
  return (issues || []).filter((i) => !i.pull_request);
}

export async function fetchIssue(number: number): Promise<Issue> {
  return gh<Issue>(`/repos/${slug()}/issues/${number}`);
}

export async function fetchIssueComments(number: number): Promise<Comment[]> {
  return (await gh<Comment[]>(`/repos/${slug()}/issues/${number}/comments?per_page=100`)) || [];
}

export async function createIssue(title: string, body: string): Promise<Issue> {
  return gh<Issue>(`/repos/${slug()}/issues`, { method: 'POST', body: { title, body } });
}

export async function createComment(number: number, body: string): Promise<Comment> {
  return gh<Comment>(`/repos/${slug()}/issues/${number}/comments`, { method: 'POST', body: { body } });
}

export async function setIssueState(number: number, issueState: 'open' | 'closed'): Promise<Issue> {
  return gh<Issue>(`/repos/${slug()}/issues/${number}`, { method: 'PATCH', body: { state: issueState } });
}

// ── Pull requests ───────────────────────────────────────────────────────────
export async function fetchPulls(prState: 'open' | 'closed'): Promise<Pull[]> {
  return (await gh<Pull[]>(`/repos/${slug()}/pulls?state=${prState}&per_page=50&sort=updated&direction=desc`)) || [];
}

export async function fetchPull(number: number): Promise<Pull> {
  return gh<Pull>(`/repos/${slug()}/pulls/${number}`);
}

export async function fetchPullCommits(number: number): Promise<CommitItem[]> {
  return (await gh<CommitItem[]>(`/repos/${slug()}/pulls/${number}/commits?per_page=100`)) || [];
}

export async function fetchPullComments(number: number): Promise<Comment[]> {
  // PR conversation comments live on the issue comments endpoint.
  return (await gh<Comment[]>(`/repos/${slug()}/issues/${number}/comments?per_page=100`)) || [];
}

// ── Releases ────────────────────────────────────────────────────────────────
export async function fetchReleases(): Promise<Release[]> {
  return (await gh<Release[]>(`/repos/${slug()}/releases?per_page=50`)) || [];
}

// ── Code / contents ─────────────────────────────────────────────────────────
export async function fetchContents(path: string): Promise<ContentEntry[] | ContentEntry> {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return gh<ContentEntry[] | ContentEntry>(`/repos/${slug()}/contents/${clean}`);
}

export async function fetchFileContent(path: string): Promise<{ content: string; encoding: string; size: number; name: string; download_url: string | null }> {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return gh<{ content: string; encoding: string; size: number; name: string; download_url: string | null }>(`/repos/${slug()}/contents/${clean}`);
}
