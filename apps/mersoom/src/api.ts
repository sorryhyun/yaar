import { solvePow } from "./pow";
import type { Challenge, Comment, CommentsResponse, FeedResponse, Post } from "./types";

const API_BASE = "https://mersoom.com/api";

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function getChallenge(): Promise<Challenge> {
  const res = await fetch(`${API_BASE}/challenge`, {
    method: "POST",
  });
  return parseJson<Challenge>(res);
}

async function withPowHeaders(init?: RequestInit): Promise<RequestInit> {
  const challenge = await getChallenge();

  // Start with server hint, then expand budget gradually on timeout.
  const requestedMs = Math.max(challenge.limit_ms ?? 1900, 1200);
  // Keep first attempt fast, then expand for difficult challenges.
  const budgets = [requestedMs, Math.max(requestedMs * 2, 30000), 60000];

  let lastErr: unknown;
  let pow: { nonce: string } | null = null;

  for (const budget of budgets) {
    try {
      pow = await solvePow(challenge.seed, challenge.target_prefix, budget);
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!pow) {
    throw lastErr instanceof Error ? lastErr : new Error("PoW solve failed");
  }

  const headers = new Headers(init?.headers ?? {});
  headers.set("Content-Type", "application/json");
  headers.set("X-Mersoom-Token", challenge.challenge_id);
  headers.set("X-Mersoom-Proof", pow.nonce);

  return {
    ...(init ?? {}),
    headers,
  };
}

async function postWithPow<T>(path: string, body: unknown): Promise<T> {
  const init = await withPowHeaders({
    method: "POST",
    body: JSON.stringify(body),
  });
  const res = await fetch(`${API_BASE}${path}`, init);

  if (!res.ok && (res.status === 400 || res.status === 401)) {
    const retryInit = await withPowHeaders({
      method: "POST",
      body: JSON.stringify(body),
    });
    const retryRes = await fetch(`${API_BASE}${path}`, retryInit);
    return parseJson<T>(retryRes);
  }

  return parseJson<T>(res);
}

export async function fetchPosts(limit = 20, cursor?: string | null): Promise<{ posts: Post[]; nextCursor: string | null }> {
  const url = new URL(`${API_BASE}/posts`);
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);

  const res = await fetch(url.toString());
  const data = await parseJson<FeedResponse>(res);
  const posts = data.items ?? data.posts ?? [];
  return {
    posts,
    nextCursor: data.next_cursor ?? data.cursor ?? null,
  };
}

export async function fetchPost(postId: string): Promise<Post> {
  const res = await fetch(`${API_BASE}/posts/${postId}`);
  return parseJson<Post>(res);
}

export async function fetchComments(postId: string): Promise<Comment[]> {
  const res = await fetch(`${API_BASE}/posts/${postId}/comments`);
  const data = await parseJson<CommentsResponse>(res);
  return data.items ?? data.comments ?? [];
}

export async function createPost(payload: {
  nickname: string;
  title: string;
  content: string;
}): Promise<Post> {
  return postWithPow<Post>("/posts", payload);
}

export async function createComment(
  postId: string,
  payload: { nickname: string; content: string; parent_id?: string },
): Promise<Comment> {
  return postWithPow<Comment>(`/posts/${postId}/comments`, payload);
}

export async function votePost(postId: string, type: "up" | "down"): Promise<{ ok?: boolean }> {
  return postWithPow<{ ok?: boolean }>(`/posts/${postId}/vote`, { type });
}
