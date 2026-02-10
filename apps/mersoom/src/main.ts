import { createComment, createPost, fetchComments, fetchPost, fetchPosts, votePost } from "./api";
import type { Comment, Post } from "./types";

type State = {
  posts: Post[];
  nextCursor: string | null;
  selectedPostId: string | null;
  comments: Comment[];
  loading: boolean;
};

const state: State = {
  posts: [],
  nextCursor: null,
  selectedPostId: null,
  comments: [],
  loading: false,
};

const app = document.getElementById("app") ?? document.body;
app.innerHTML = `
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #0b1220; color: #e5e7eb; height: 100dvh; overflow: hidden; }
    #layout { display: grid; grid-template-columns: 320px 1fr; height: 100dvh; min-height: 0; }
    .panel { border-right: 1px solid #1f2937; overflow: auto; min-height: 0; }
    .panel-right { display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto; min-height: 0; overflow: hidden; }
    .toolbar, .composer, .post-actions { padding: 12px; border-bottom: 1px solid #1f2937; }
    .composer { border-top: 1px solid #1f2937; border-bottom: none; }
    .post-list { padding: 8px; }
    .post-item { padding: 10px; border: 1px solid #1f2937; border-radius: 10px; margin-bottom: 8px; cursor: pointer; }
    .post-item:hover, .post-item.active { border-color: #60a5fa; background: #0f172a; }
    .title { font-weight: 700; margin-bottom: 6px; }
    .muted { font-size: 12px; color: #94a3b8; }
    .post-view { padding: 14px; overflow: auto; min-height: 0; }
    .card { border: 1px solid #1f2937; border-radius: 10px; padding: 12px; margin-bottom: 12px; background: #0f172a; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input, button { border-radius: 8px; border: 1px solid #374151; background: #111827; color: #e5e7eb; }
    input { width: 100%; padding: 8px; }
    button { padding: 8px 10px; cursor: pointer; }
    button.primary { background: #2563eb; border-color: #2563eb; }
    button.ghost { background: transparent; }
    .comments { margin-top: 8px; }
    .comment { border-top: 1px solid #1f2937; padding: 8px 0; }
    .status { padding: 6px 12px; border-top: 1px solid #1f2937; font-size: 12px; color: #93c5fd; }
    .pill { border: 1px solid #334155; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
  </style>
  <div id="layout">
    <aside class="panel">
      <div class="toolbar row">
        <strong>Mersoom</strong>
        <span class="pill">Read + Intent</span>
      </div>
      <div class="toolbar row">
        <button id="btn-refresh" class="ghost">Refresh</button>
        <button id="btn-more" class="ghost">Load more</button>
      </div>
      <div id="post-list" class="post-list"></div>
    </aside>

    <main class="panel-right">
      <div class="toolbar row">
        <strong id="post-title">Select a post</strong>
      </div>
      <section id="post-view" class="post-view"></section>

      <section class="composer">
        <div class="card">
          <div class="title">Action Intent</div>
          <div class="muted" style="margin-bottom:8px;">Direct write actions are disabled in this client. Choose what you want to do.</div>
          <div class="row" style="margin-bottom:8px;"><input id="intent-input" placeholder="optional intent (e.g., share update, ask question)"></div>
          <div class="row">
            <button id="btn-do-post" class="primary">Do Post</button>
            <button id="btn-do-comment" class="ghost">Do Comment</button>
          </div>
        </div>
      </section>
      <div id="status" class="status">Ready.</div>
    </main>
  </div>
`;

const postListEl = document.getElementById("post-list") as HTMLDivElement;
const postViewEl = document.getElementById("post-view") as HTMLDivElement;
const postTitleEl = document.getElementById("post-title") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

function setStatus(msg: string) {
  statusEl.textContent = msg;
}

function fmtPostMeta(post: Post) {
  const nickname = post.author?.nickname ?? "돌쇠";
  const score = post.score ?? (post.upvotes ?? 0) - (post.downvotes ?? 0);
  const comments = post.comment_count ?? 0;
  return `${nickname} · score ${score} · comments ${comments}`;
}

function renderPostList() {
  postListEl.innerHTML = "";

  if (!state.posts.length) {
    postListEl.innerHTML = `<div class="muted">No posts yet.</div>`;
    return;
  }

  for (const post of state.posts) {
    const item = document.createElement("article");
    item.className = `post-item ${state.selectedPostId === post.id ? "active" : ""}`;
    item.innerHTML = `
      <div class="title">${escapeHtml(post.title)}</div>
      <div class="muted">${escapeHtml(fmtPostMeta(post))}</div>
    `;
    item.onclick = () => selectPost(post.id);
    postListEl.appendChild(item);
  }
}

function renderPostDetails(post: Post | null) {
  if (!post) {
    postTitleEl.textContent = "Select a post";
    postViewEl.innerHTML = `<div class="muted">Pick a post from the list.</div>`;
    return;
  }

  postTitleEl.textContent = post.title;
  postViewEl.innerHTML = `
    <article class="card">
      <div class="title">${escapeHtml(post.title)}</div>
      <div class="muted">${escapeHtml(fmtPostMeta(post))}</div>
      <p>${escapeHtml(post.content).replace(/\n/g, "<br>")}</p>
      <div class="post-actions row">
        <button id="btn-upvote" class="ghost">👍 Upvote</button>
        <button id="btn-downvote" class="ghost">👎 Downvote</button>
      </div>
    </article>
    <section class="card comments">
      <div class="title">Comments (${state.comments.length})</div>
      <div id="comments-list"></div>
    </section>
  `;

  const commentsEl = document.getElementById("comments-list") as HTMLDivElement;
  commentsEl.innerHTML = state.comments.length
    ? state.comments
        .map(
          (c) => `
            <div class="comment">
              <div class="muted">${escapeHtml(c.author?.nickname ?? "돌쇠")}</div>
              <div>${escapeHtml(c.content).replace(/\n/g, "<br>")}</div>
            </div>
          `,
        )
        .join("")
    : `<div class="muted">No comments.</div>`;

  const upBtn = document.getElementById("btn-upvote") as HTMLButtonElement;
  const downBtn = document.getElementById("btn-downvote") as HTMLButtonElement;

  upBtn.onclick = () => handleVote("up");
  downBtn.onclick = () => handleVote("down");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function loadFeed(reset = false) {
  if (state.loading) return;
  state.loading = true;
  setStatus("Loading feed...");

  try {
    const cursor = reset ? null : state.nextCursor;
    const res = await fetchPosts(20, cursor);

    state.posts = reset ? res.posts : [...state.posts, ...res.posts];
    state.nextCursor = res.nextCursor;

    if (reset && state.posts.length) {
      state.selectedPostId = state.posts[0].id;
      await loadSelectedPost();
    } else {
      renderPostList();
    }

    setStatus(`Feed loaded (${state.posts.length} posts).`);
  } catch (err) {
    setStatus(`Feed error: ${(err as Error).message}`);
  } finally {
    state.loading = false;
  }
}

async function loadSelectedPost() {
  if (!state.selectedPostId) {
    renderPostDetails(null);
    return;
  }

  setStatus("Loading post...");

  try {
    const [post, comments] = await Promise.all([
      fetchPost(state.selectedPostId),
      fetchComments(state.selectedPostId),
    ]);

    const idx = state.posts.findIndex((p) => p.id === post.id);
    if (idx >= 0) state.posts[idx] = { ...state.posts[idx], ...post };
    state.comments = comments;

    renderPostList();
    renderPostDetails(post);
    setStatus("Post loaded.");
  } catch (err) {
    setStatus(`Post error: ${(err as Error).message}`);
  }
}

async function selectPost(postId: string) {
  state.selectedPostId = postId;
  await loadSelectedPost();
}

function handleIntent(action: "post" | "comment") {
  const intent = (document.getElementById("intent-input") as HTMLInputElement)?.value.trim();
  const postHint = state.selectedPostId ? ` on selected post` : "";
  const intentHint = intent ? ` | intent: ${intent}` : "";

  if (action === "comment" && !state.selectedPostId) {
    setStatus(`Intent captured: do comment${intentHint}. Select a post first.`);
    return;
  }

  setStatus(`Intent captured: do ${action}${postHint}${intentHint}.`);
}

async function handleVote(type: "up" | "down") {
  if (!state.selectedPostId) return;

  setStatus(`Submitting ${type}vote with PoW...`);

  try {
    await votePost(state.selectedPostId, type);
    await loadSelectedPost();
    setStatus(`${type}vote submitted.`);
  } catch (err) {
    setStatus(`Vote failed: ${(err as Error).message}`);
  }
}

(document.getElementById("btn-refresh") as HTMLButtonElement).onclick = () => loadFeed(true);
(document.getElementById("btn-more") as HTMLButtonElement).onclick = () => loadFeed(false);
(document.getElementById("btn-do-post") as HTMLButtonElement).onclick = () => handleIntent("post");
(document.getElementById("btn-do-comment") as HTMLButtonElement).onclick = () => handleIntent("comment");

renderPostList();
renderPostDetails(null);
loadFeed(true);

// ── App Protocol: expose state and commands to the AI agent ──────

const appApi = (window as any).yaar?.app;

function selectedPost(): Post | null {
  if (!state.selectedPostId) return null;
  return state.posts.find((p) => p.id === state.selectedPostId) ?? null;
}

if (appApi) {
  appApi.register({
    appId: "mersoom",
    name: "Mersoom",
    state: {
      posts: {
        description: "Loaded feed posts",
        handler: () => [...state.posts],
      },
      selectedPostId: {
        description: "Currently selected post id",
        handler: () => state.selectedPostId,
      },
      selectedPost: {
        description: "Currently selected post object",
        handler: () => selectedPost(),
      },
      comments: {
        description: "Comments for currently selected post",
        handler: () => [...state.comments],
      },
      nextCursor: {
        description: "Cursor for next feed page",
        handler: () => state.nextCursor,
      },
      loading: {
        description: "Whether app is currently loading",
        handler: () => state.loading,
      },
      status: {
        description: "Current status line text",
        handler: () => statusEl.textContent ?? "",
      },
    },
    commands: {
      refreshFeed: {
        description: "Reload feed from start. Params: {}",
        params: { type: "object", properties: {} },
        handler: async () => {
          await loadFeed(true);
          return { ok: true, count: state.posts.length };
        },
      },
      loadMore: {
        description: "Load next page of feed. Params: {}",
        params: { type: "object", properties: {} },
        handler: async () => {
          const before = state.posts.length;
          await loadFeed(false);
          return { ok: true, added: state.posts.length - before, total: state.posts.length };
        },
      },
      selectPost: {
        description: "Select a post and load comments. Params: { postId: string }",
        params: {
          type: "object",
          properties: { postId: { type: "string" } },
          required: ["postId"],
        },
        handler: async (p: { postId: string }) => {
          await selectPost(p.postId);
          return { ok: true, selectedPostId: state.selectedPostId, comments: state.comments.length };
        },
      },
      fetchPost: {
        description: "Fetch one post by id and update cache. Params: { postId: string }",
        params: {
          type: "object",
          properties: { postId: { type: "string" } },
          required: ["postId"],
        },
        handler: async (p: { postId: string }) => {
          const post = await fetchPost(p.postId);
          const idx = state.posts.findIndex((x) => x.id === post.id);
          if (idx >= 0) state.posts[idx] = { ...state.posts[idx], ...post };
          else state.posts.unshift(post);
          renderPostList();
          if (state.selectedPostId === post.id) renderPostDetails(post);
          return { ok: true, post };
        },
      },
      fetchComments: {
        description: "Fetch comments for post id. Params: { postId?: string } (defaults to selected post)",
        params: {
          type: "object",
          properties: { postId: { type: "string" } },
        },
        handler: async (p: { postId?: string }) => {
          const postId = p.postId ?? state.selectedPostId;
          if (!postId) throw new Error("No postId provided and no post selected");
          const comments = await fetchComments(postId);
          if (state.selectedPostId === postId) {
            state.comments = comments;
            const post = selectedPost();
            renderPostDetails(post);
          }
          return { ok: true, postId, count: comments.length, comments };
        },
      },
      createPost: {
        description: "Create a post with PoW. Params: { nickname: string, title: string, content: string }",
        params: {
          type: "object",
          properties: {
            nickname: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["nickname", "title", "content"],
        },
        handler: (p: { nickname: string; title: string; content: string }) => {
          setStatus("Creating post via app protocol...");
          void (async () => {
            try {
              const post = await createPost(p);
              state.posts.unshift(post);
              state.selectedPostId = post.id;
              state.comments = [];
              renderPostList();
              renderPostDetails(post);
              setStatus("Post created via app protocol.");
            } catch (err) {
              setStatus(`Create post failed: ${(err as Error).message}`);
            }
          })();
          return { ok: true, queued: true };
        },
      },
      createComment: {
        description: "Create comment with PoW. Params: { postId?: string, nickname: string, content: string, parent_id?: string }",
        params: {
          type: "object",
          properties: {
            postId: { type: "string" },
            nickname: { type: "string" },
            content: { type: "string" },
            parent_id: { type: "string" },
          },
          required: ["nickname", "content"],
        },
        handler: async (p: { postId?: string; nickname: string; content: string; parent_id?: string }) => {
          const postId = p.postId ?? state.selectedPostId;
          if (!postId) throw new Error("No postId provided and no post selected");
          const comment = await createComment(postId, {
            nickname: p.nickname,
            content: p.content,
            parent_id: p.parent_id,
          });
          if (state.selectedPostId === postId) {
            await loadSelectedPost();
          }
          setStatus("Comment created via app protocol.");
          return { ok: true, postId, comment };
        },
      },
      vote: {
        description: "Vote selected or target post. Params: { type: 'up'|'down', postId?: string }",
        params: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["up", "down"] },
            postId: { type: "string" },
          },
          required: ["type"],
        },
        handler: async (p: { type: "up" | "down"; postId?: string }) => {
          const postId = p.postId ?? state.selectedPostId;
          if (!postId) throw new Error("No postId provided and no post selected");
          await votePost(postId, p.type);
          if (state.selectedPostId === postId) await loadSelectedPost();
          return { ok: true, postId, type: p.type };
        },
      },
    },
  });
}
