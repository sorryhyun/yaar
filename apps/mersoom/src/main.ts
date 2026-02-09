import {
  createComment,
  createPost,
  fetchComments,
  fetchPost,
  fetchPosts,
  votePost,
} from "./api";
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
    body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #0b1220; color: #e5e7eb; }
    #layout { display: grid; grid-template-columns: 320px 1fr; height: 100vh; }
    .panel { border-right: 1px solid #1f2937; overflow: auto; }
    .panel-right { display: grid; grid-template-rows: auto 1fr auto; }
    .toolbar, .composer, .post-actions { padding: 12px; border-bottom: 1px solid #1f2937; }
    .composer { border-top: 1px solid #1f2937; border-bottom: none; }
    .post-list { padding: 8px; }
    .post-item { padding: 10px; border: 1px solid #1f2937; border-radius: 10px; margin-bottom: 8px; cursor: pointer; }
    .post-item:hover, .post-item.active { border-color: #60a5fa; background: #0f172a; }
    .title { font-weight: 700; margin-bottom: 6px; }
    .muted { font-size: 12px; color: #94a3b8; }
    .post-view { padding: 14px; overflow: auto; }
    .card { border: 1px solid #1f2937; border-radius: 10px; padding: 12px; margin-bottom: 12px; background: #0f172a; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input, textarea, button { border-radius: 8px; border: 1px solid #374151; background: #111827; color: #e5e7eb; }
    input, textarea { width: 100%; padding: 8px; }
    textarea { min-height: 72px; resize: vertical; }
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
        <span class="pill">Components UI</span>
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
          <div class="title">New Post</div>
          <div class="row" style="margin-bottom:8px;"><input id="new-nickname" maxlength="10" placeholder="nickname (max 10)" value="돌쇠"></div>
          <div class="row" style="margin-bottom:8px;"><input id="new-title" placeholder="title"></div>
          <div class="row" style="margin-bottom:8px;"><textarea id="new-content" placeholder="content"></textarea></div>
          <div class="row"><button id="btn-create-post" class="primary">Create Post (PoW)</button></div>
        </div>

        <div class="card">
          <div class="title">Comment on selected post</div>
          <div class="row" style="margin-bottom:8px;"><input id="comment-nickname" maxlength="10" placeholder="nickname (max 10)" value="돌쇠"></div>
          <div class="row" style="margin-bottom:8px;"><textarea id="comment-content" placeholder="comment"></textarea></div>
          <div class="row"><button id="btn-create-comment" class="primary">Create Comment (PoW)</button></div>
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

function nicknameFrom(id: string) {
  const value = (document.getElementById(id) as HTMLInputElement).value.trim() || "돌쇠";
  return value.slice(0, 10);
}

async function handleCreatePost() {
  const nickname = nicknameFrom("new-nickname");
  const title = (document.getElementById("new-title") as HTMLInputElement).value.trim();
  const content = (document.getElementById("new-content") as HTMLTextAreaElement).value.trim();

  if (!title || !content) {
    setStatus("Title and content are required.");
    return;
  }

  setStatus("Creating post with PoW...");

  try {
    const created = await createPost({ nickname, title, content });
    (document.getElementById("new-title") as HTMLInputElement).value = "";
    (document.getElementById("new-content") as HTMLTextAreaElement).value = "";

    state.posts = [created, ...state.posts];
    state.selectedPostId = created.id;
    await loadSelectedPost();
    setStatus("Post created.");
  } catch (err) {
    setStatus(`Create post failed: ${(err as Error).message}`);
  }
}

async function handleCreateComment() {
  if (!state.selectedPostId) {
    setStatus("Select a post first.");
    return;
  }

  const nickname = nicknameFrom("comment-nickname");
  const content = (document.getElementById("comment-content") as HTMLTextAreaElement).value.trim();

  if (!content) {
    setStatus("Comment is required.");
    return;
  }

  setStatus("Creating comment with PoW...");

  try {
    await createComment(state.selectedPostId, { nickname, content });
    (document.getElementById("comment-content") as HTMLTextAreaElement).value = "";
    await loadSelectedPost();
    setStatus("Comment created.");
  } catch (err) {
    setStatus(`Create comment failed: ${(err as Error).message}`);
  }
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
(document.getElementById("btn-create-post") as HTMLButtonElement).onclick = handleCreatePost;
(document.getElementById("btn-create-comment") as HTMLButtonElement).onclick = handleCreateComment;

renderPostList();
renderPostDetails(null);
loadFeed(true);
