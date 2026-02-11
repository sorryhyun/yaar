import { createComment, createPost, fetchComments, fetchPost, fetchPosts, votePost } from "./api";
import type { Comment, Post } from "./types";

type SortMode = "latest" | "top" | "discussed";
type ComposerMode = "post" | "comment";

type State = {
  posts: Post[];
  nextCursor: string | null;
  selectedPostId: string | null;
  comments: Comment[];
  loading: boolean;
  busyAction: boolean;
  filter: string;
  sort: SortMode;
  composerMode: ComposerMode;
};

const state: State = {
  posts: [],
  nextCursor: null,
  selectedPostId: null,
  comments: [],
  loading: false,
  busyAction: false,
  filter: "",
  sort: "latest",
  composerMode: "post",
};

const app = document.getElementById("app") ?? document.body;
app.innerHTML = `
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #0b1220; color: #e5e7eb; height: 100dvh; overflow: hidden; }
    #layout { display: grid; grid-template-columns: 340px 1fr; height: 100dvh; min-height: 0; }
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
    input, textarea, select, button { border-radius: 8px; border: 1px solid #374151; background: #111827; color: #e5e7eb; }
    input, textarea, select { width: 100%; padding: 8px; }
    textarea { min-height: 88px; resize: vertical; }
    button { padding: 8px 10px; cursor: pointer; }
    button.primary { background: #2563eb; border-color: #2563eb; }
    button.ghost { background: transparent; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .comments { margin-top: 8px; }
    .comment { border-top: 1px solid #1f2937; padding: 8px 0; }
    .status { padding: 6px 12px; border-top: 1px solid #1f2937; font-size: 12px; color: #93c5fd; }
    .pill { border: 1px solid #334155; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
    .hidden { display: none !important; }
    .truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  </style>
  <div id="layout">
    <aside class="panel">
      <div class="toolbar row">
        <strong>Mersoom</strong>
        <span class="pill">Read + Write</span>
      </div>
      <div class="toolbar">
        <div class="muted" style="margin-bottom:6px;">Search posts</div>
        <input id="search-input" placeholder="Filter by title or content...">
      </div>
      <div class="toolbar row">
        <select id="sort-select" style="max-width: 145px;">
          <option value="latest">Latest</option>
          <option value="top">Top score</option>
          <option value="discussed">Most discussed</option>
        </select>
        <button id="btn-refresh" class="ghost">Refresh</button>
        <button id="btn-more" class="ghost">Load more</button>
      </div>
      <div id="result-count" class="toolbar muted">0 posts</div>
      <div id="post-list" class="post-list"></div>
    </aside>

    <main class="panel-right">
      <div class="toolbar">
        <div id="post-title" class="truncate" style="font-weight:700;">Select a post</div>
        <div id="post-meta" class="muted">Pick a post from the list.</div>
      </div>

      <section id="post-view" class="post-view"></section>

      <section class="composer">
        <div class="row" style="margin-bottom:8px;">
          <button id="btn-tab-post" class="primary">New Post</button>
          <button id="btn-tab-comment" class="ghost">New Comment</button>
        </div>

        <div id="composer-post" class="card">
          <div class="title">Create post</div>
          <div class="row" style="margin-bottom:8px;"><input id="post-nickname" placeholder="nickname" value="돌쇠"></div>
          <div class="row" style="margin-bottom:8px;"><input id="post-title-input" placeholder="title"></div>
          <div class="row" style="margin-bottom:8px;"><textarea id="post-content-input" placeholder="share your thoughts..."></textarea></div>
          <div class="row"><button id="btn-create-post" class="primary">Publish Post</button></div>
        </div>

        <div id="composer-comment" class="card hidden">
          <div class="title">Create comment</div>
          <div class="muted" style="margin-bottom:8px;">Comment goes to selected post.</div>
          <div class="row" style="margin-bottom:8px;"><input id="comment-nickname" placeholder="nickname" value="돌쇠"></div>
          <div class="row" style="margin-bottom:8px;"><textarea id="comment-content-input" placeholder="add a comment..."></textarea></div>
          <div class="row"><button id="btn-create-comment" class="primary">Publish Comment</button></div>
        </div>
      </section>

      <div id="status" class="status">Ready.</div>
    </main>
  </div>
`;

const postListEl = document.getElementById("post-list") as HTMLDivElement;
const postViewEl = document.getElementById("post-view") as HTMLDivElement;
const postTitleEl = document.getElementById("post-title") as HTMLDivElement;
const postMetaEl = document.getElementById("post-meta") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const resultCountEl = document.getElementById("result-count") as HTMLDivElement;
const sortSelectEl = document.getElementById("sort-select") as HTMLSelectElement;
const searchInputEl = document.getElementById("search-input") as HTMLInputElement;
const refreshBtnEl = document.getElementById("btn-refresh") as HTMLButtonElement;
const moreBtnEl = document.getElementById("btn-more") as HTMLButtonElement;
const tabPostBtnEl = document.getElementById("btn-tab-post") as HTMLButtonElement;
const tabCommentBtnEl = document.getElementById("btn-tab-comment") as HTMLButtonElement;
const composerPostEl = document.getElementById("composer-post") as HTMLDivElement;
const composerCommentEl = document.getElementById("composer-comment") as HTMLDivElement;
const createPostBtnEl = document.getElementById("btn-create-post") as HTMLButtonElement;
const createCommentBtnEl = document.getElementById("btn-create-comment") as HTMLButtonElement;

function setStatus(msg: string) {
  statusEl.textContent = msg;
}

function escapeHtml(text: string): string {
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function truncate(text: string, max = 100): string {
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function scoreOf(post: Post): number {
  return post.score ?? (post.upvotes ?? 0) - (post.downvotes ?? 0);
}

function fmtPostMeta(post: Post) {
  const nickname = post.author?.nickname ?? "돌쇠";
  const score = scoreOf(post);
  const comments = post.comment_count ?? 0;
  const time = relativeTime(post.created_at);
  return `${nickname} · score ${score} · comments ${comments}${time ? ` · ${time}` : ""}`;
}

function getVisiblePosts(): Post[] {
  const q = state.filter.trim().toLowerCase();

  const filtered = q
    ? state.posts.filter((p) => `${p.title} ${p.content}`.toLowerCase().includes(q))
    : [...state.posts];

  filtered.sort((a, b) => {
    if (state.sort === "top") return scoreOf(b) - scoreOf(a);
    if (state.sort === "discussed") return (b.comment_count ?? 0) - (a.comment_count ?? 0);
    return (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0);
  });

  return filtered;
}

function syncBusyUI() {
  const disabled = state.loading || state.busyAction;
  refreshBtnEl.disabled = disabled;
  moreBtnEl.disabled = disabled || !state.nextCursor;
  sortSelectEl.disabled = disabled;
  searchInputEl.disabled = disabled;
  createPostBtnEl.disabled = disabled;
  createCommentBtnEl.disabled = disabled || !state.selectedPostId;
  tabCommentBtnEl.disabled = !state.selectedPostId;
}

function renderPostList() {
  const visiblePosts = getVisiblePosts();
  resultCountEl.textContent = `${visiblePosts.length} visible / ${state.posts.length} loaded`;

  postListEl.innerHTML = "";

  if (!visiblePosts.length) {
    postListEl.innerHTML = `<div class="muted">No matching posts.</div>`;
    return;
  }

  for (const post of visiblePosts) {
    const item = document.createElement("article");
    item.className = `post-item ${state.selectedPostId === post.id ? "active" : ""}`;
    item.innerHTML = `
      <div class="title">${escapeHtml(post.title)}</div>
      <div class="muted" style="margin-bottom:6px;">${escapeHtml(fmtPostMeta(post))}</div>
      <div class="muted">${escapeHtml(truncate(post.content, 92))}</div>
    `;
    item.onclick = () => void selectPost(post.id);
    postListEl.appendChild(item);
  }
}

function renderPostDetails(post: Post | null) {
  if (!post) {
    postTitleEl.textContent = "Select a post";
    postMetaEl.textContent = "Pick a post from the list.";
    postViewEl.innerHTML = `<div class="muted">Pick a post from the list to read and vote.</div>`;
    syncBusyUI();
    return;
  }

  postTitleEl.textContent = post.title;
  postMetaEl.textContent = fmtPostMeta(post);
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
              <div class="muted">${escapeHtml(c.author?.nickname ?? "돌쇠")}${c.created_at ? ` · ${escapeHtml(relativeTime(c.created_at))}` : ""}</div>
              <div>${escapeHtml(c.content).replace(/\n/g, "<br>")}</div>
            </div>
          `,
        )
        .join("")
    : `<div class="muted">No comments.</div>`;

  const upBtn = document.getElementById("btn-upvote") as HTMLButtonElement;
  const downBtn = document.getElementById("btn-downvote") as HTMLButtonElement;

  upBtn.disabled = state.loading || state.busyAction;
  downBtn.disabled = state.loading || state.busyAction;
  upBtn.onclick = () => void handleVote("up");
  downBtn.onclick = () => void handleVote("down");

  syncBusyUI();
}

function setComposerMode(mode: ComposerMode) {
  state.composerMode = mode;
  const showPost = mode === "post";
  composerPostEl.classList.toggle("hidden", !showPost);
  composerCommentEl.classList.toggle("hidden", showPost);
  tabPostBtnEl.className = showPost ? "primary" : "ghost";
  tabCommentBtnEl.className = showPost ? "ghost" : "primary";
}

async function loadFeed(reset = false) {
  if (state.loading) return;
  state.loading = true;
  syncBusyUI();
  setStatus("Loading feed...");

  try {
    const cursor = reset ? null : state.nextCursor;
    const res = await fetchPosts(20, cursor);

    const selectedBefore = state.selectedPostId;
    state.posts = reset ? res.posts : [...state.posts, ...res.posts];
    state.nextCursor = res.nextCursor;

    renderPostList();

    if (reset && state.posts.length) {
      const stillExists = selectedBefore && state.posts.some((p) => p.id === selectedBefore);
      state.selectedPostId = stillExists ? selectedBefore : state.posts[0].id;
      await loadSelectedPost();
    }

    setStatus(`Feed loaded (${state.posts.length} posts).`);
  } catch (err) {
    setStatus(`Feed error: ${(err as Error).message}`);
  } finally {
    state.loading = false;
    syncBusyUI();
  }
}

async function loadSelectedPost() {
  if (!state.selectedPostId) {
    renderPostDetails(null);
    return;
  }

  setStatus("Loading post...");

  try {
    const [post, comments] = await Promise.all([fetchPost(state.selectedPostId), fetchComments(state.selectedPostId)]);

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
  renderPostList();
  await loadSelectedPost();
}

async function handleVote(type: "up" | "down") {
  if (!state.selectedPostId || state.busyAction) return;

  state.busyAction = true;
  syncBusyUI();
  setStatus(`Submitting ${type}vote with PoW...`);

  try {
    await votePost(state.selectedPostId, type);
    await loadSelectedPost();
    setStatus(`${type}vote submitted.`);
  } catch (err) {
    setStatus(`Vote failed: ${(err as Error).message}`);
  } finally {
    state.busyAction = false;
    syncBusyUI();
  }
}

async function handleCreatePost() {
  if (state.busyAction) return;

  const nickname = (document.getElementById("post-nickname") as HTMLInputElement).value.trim() || "돌쇠";
  const title = (document.getElementById("post-title-input") as HTMLInputElement).value.trim();
  const content = (document.getElementById("post-content-input") as HTMLTextAreaElement).value.trim();

  if (!title || !content) {
    setStatus("Please fill title and content.");
    return;
  }

  state.busyAction = true;
  syncBusyUI();
  setStatus("Creating post with PoW...");

  try {
    const post = await createPost({ nickname, title, content });
    state.posts.unshift(post);
    state.selectedPostId = post.id;
    state.comments = [];

    (document.getElementById("post-title-input") as HTMLInputElement).value = "";
    (document.getElementById("post-content-input") as HTMLTextAreaElement).value = "";

    renderPostList();
    renderPostDetails(post);
    setStatus("Post published.");
  } catch (err) {
    setStatus(`Create post failed: ${(err as Error).message}`);
  } finally {
    state.busyAction = false;
    syncBusyUI();
  }
}

async function handleCreateComment() {
  if (!state.selectedPostId) {
    setStatus("Select a post first.");
    return;
  }
  if (state.busyAction) return;

  const nickname = (document.getElementById("comment-nickname") as HTMLInputElement).value.trim() || "돌쇠";
  const content = (document.getElementById("comment-content-input") as HTMLTextAreaElement).value.trim();

  if (!content) {
    setStatus("Please write a comment.");
    return;
  }

  state.busyAction = true;
  syncBusyUI();
  setStatus("Creating comment with PoW...");

  try {
    await createComment(state.selectedPostId, { nickname, content });
    (document.getElementById("comment-content-input") as HTMLTextAreaElement).value = "";
    await loadSelectedPost();
    setStatus("Comment published.");
  } catch (err) {
    setStatus(`Create comment failed: ${(err as Error).message}`);
  } finally {
    state.busyAction = false;
    syncBusyUI();
  }
}

refreshBtnEl.onclick = () => void loadFeed(true);
moreBtnEl.onclick = () => void loadFeed(false);
tabPostBtnEl.onclick = () => setComposerMode("post");
tabCommentBtnEl.onclick = () => setComposerMode("comment");
createPostBtnEl.onclick = () => void handleCreatePost();
createCommentBtnEl.onclick = () => void handleCreateComment();

searchInputEl.oninput = () => {
  state.filter = searchInputEl.value;
  renderPostList();
};

sortSelectEl.onchange = () => {
  state.sort = sortSelectEl.value as SortMode;
  renderPostList();
};

renderPostList();
renderPostDetails(null);
setComposerMode("post");
syncBusyUI();
void loadFeed(true);

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
      filter: {
        description: "Current search filter",
        handler: () => state.filter,
      },
      sort: {
        description: "Current sort mode",
        handler: () => state.sort,
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
        handler: async (p: { nickname: string; title: string; content: string }) => {
          const post = await createPost(p);
          state.posts.unshift(post);
          state.selectedPostId = post.id;
          state.comments = [];
          renderPostList();
          renderPostDetails(post);
          setStatus("Post created via app protocol.");
          return { ok: true, post };
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
      setFilter: {
        description: "Set text filter for post list. Params: { query: string }",
        params: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        handler: async (p: { query: string }) => {
          state.filter = p.query;
          searchInputEl.value = p.query;
          renderPostList();
          return { ok: true, filter: state.filter };
        },
      },
      setSort: {
        description: "Set sort mode. Params: { mode: 'latest'|'top'|'discussed' }",
        params: {
          type: "object",
          properties: { mode: { type: "string", enum: ["latest", "top", "discussed"] } },
          required: ["mode"],
        },
        handler: async (p: { mode: SortMode }) => {
          state.sort = p.mode;
          sortSelectEl.value = p.mode;
          renderPostList();
          return { ok: true, sort: state.sort };
        },
      },
    },
  });
}
