import { signal, computed, css, html, mount, show } from "@bundled/yaar";
import { createComment, createPost, fetchComments, fetchPost, fetchPosts, votePost } from "./api";
import type { Comment, Post } from "./types";
import "./styles.css";

type SortMode = "latest" | "top" | "discussed";
type ComposerMode = "post" | "comment";

// ── Signals ──────────────────────────────────────────────────────────────────
const posts = signal<Post[]>([]);
const nextCursor = signal<string | null>(null);
const selectedPostId = signal<string | null>(null);
const comments = signal<Comment[]>([]);
const loading = signal(false);
const busyAction = signal(false);
const filter = signal("");
const sort = signal<SortMode>("latest");
const composerMode = signal<ComposerMode>("post");
const statusText = signal("Ready.");

// ── Element refs ──────────────────────────────────────────────────────────────
let searchInputEl: HTMLInputElement | null = null;
let sortSelectEl: HTMLSelectElement | null = null;
let postNicknameEl: HTMLInputElement | null = null;
let postTitleEl: HTMLInputElement | null = null;
let postContentEl: HTMLTextAreaElement | null = null;
let commentNicknameEl: HTMLInputElement | null = null;
let commentContentEl: HTMLTextAreaElement | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function fmtPostMeta(post: Post): string {
  const nickname = post.author?.nickname ?? "돌쇠";
  const score = scoreOf(post);
  const commentCount = post.comment_count ?? 0;
  const time = relativeTime(post.created_at);
  return `${nickname} · score ${score} · comments ${commentCount}${time ? ` · ${time}` : ""}`;
}

// ── Derived ───────────────────────────────────────────────────────────────────
const getVisiblePosts = computed(() => {
  const q = filter().trim().toLowerCase();
  const filtered = q
    ? posts().filter((p) => `${p.title} ${p.content}`.toLowerCase().includes(q))
    : [...posts()];
  filtered.sort((a, b) => {
    if (sort() === "top") return scoreOf(b) - scoreOf(a);
    if (sort() === "discussed") return (b.comment_count ?? 0) - (a.comment_count ?? 0);
    return (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0);
  });
  return filtered;
});

const selectedPost = computed(() => {
  const id = selectedPostId();
  if (!id) return null;
  return posts().find((p) => p.id === id) ?? null;
});

// ── Business logic ────────────────────────────────────────────────────────────
async function loadFeed(reset = false) {
  if (loading()) return;
  loading(true);
  statusText("Loading feed...");

  try {
    const cursor = reset ? null : nextCursor();
    const res = await fetchPosts(20, cursor);

    const selectedBefore = selectedPostId();
    posts(reset ? res.posts : [...posts(), ...res.posts]);
    nextCursor(res.nextCursor);

    if (reset && posts().length) {
      const stillExists = selectedBefore && posts().some((p) => p.id === selectedBefore);
      selectedPostId(stillExists ? selectedBefore : posts()[0].id);
      await loadSelectedPost();
    }

    statusText(`Feed loaded (${posts().length} posts).`);
  } catch (err) {
    statusText(`Feed error: ${(err as Error).message}`);
  } finally {
    loading(false);
  }
}

async function loadSelectedPost() {
  const id = selectedPostId();
  if (!id) return;

  statusText("Loading post...");

  try {
    const [post, fetchedComments] = await Promise.all([fetchPost(id), fetchComments(id)]);

    const idx = posts().findIndex((p) => p.id === post.id);
    if (idx >= 0) {
      const updated = [...posts()];
      updated[idx] = { ...updated[idx], ...post };
      posts(updated);
    }
    comments(fetchedComments);

    statusText("Post loaded.");
  } catch (err) {
    statusText(`Post error: ${(err as Error).message}`);
  }
}

async function selectPost(postId: string) {
  selectedPostId(postId);
  await loadSelectedPost();
}

async function handleVote(type: "up" | "down") {
  const id = selectedPostId();
  if (!id || busyAction()) return;

  busyAction(true);
  statusText(`Submitting ${type}vote with PoW...`);

  try {
    await votePost(id, type);
    await loadSelectedPost();
    statusText(`${type}vote submitted.`);
  } catch (err) {
    statusText(`Vote failed: ${(err as Error).message}`);
  } finally {
    busyAction(false);
  }
}

async function handleCreatePost() {
  if (busyAction()) return;

  const nickname = postNicknameEl?.value.trim() || "돌쇠";
  const title = postTitleEl?.value.trim() ?? "";
  const content = postContentEl?.value.trim() ?? "";

  if (!title || !content) {
    statusText("Please fill title and content.");
    return;
  }

  busyAction(true);
  statusText("Creating post with PoW...");

  try {
    const post = await createPost({ nickname, title, content });
    posts([post, ...posts()]);
    selectedPostId(post.id);
    comments([]);

    if (postTitleEl) postTitleEl.value = "";
    if (postContentEl) postContentEl.value = "";

    statusText("Post published.");
  } catch (err) {
    statusText(`Create post failed: ${(err as Error).message}`);
  } finally {
    busyAction(false);
  }
}

async function handleCreateComment() {
  const id = selectedPostId();
  if (!id) {
    statusText("Select a post first.");
    return;
  }
  if (busyAction()) return;

  const nickname = commentNicknameEl?.value.trim() || "돌쇠";
  const content = commentContentEl?.value.trim() ?? "";

  if (!content) {
    statusText("Please write a comment.");
    return;
  }

  busyAction(true);
  statusText("Creating comment with PoW...");

  try {
    await createComment(id, { nickname, content });
    if (commentContentEl) commentContentEl.value = "";
    await loadSelectedPost();
    statusText("Comment published.");
  } catch (err) {
    statusText(`Create comment failed: ${(err as Error).message}`);
  } finally {
    busyAction(false);
  }
}

// ── UI ────────────────────────────────────────────────────────────────────────
mount(html`
  <div id="layout">
    <!-- Left panel: post list -->
    <aside class="panel y-scroll">
      <div class="toolbar row">
        <strong>Mersoom</strong>
        <span class="pill y-badge">Read + Write</span>
      </div>
      <div class="toolbar">
        <div class="y-text-sm y-text-muted" style="margin-bottom:6px;">Search posts</div>
        <input
          class="y-input"
          placeholder="Filter by title or content..."
          ref=${(el: HTMLInputElement) => { searchInputEl = el; }}
          disabled=${() => loading() || busyAction()}
          onInput=${(e: Event) => { filter((e.target as HTMLInputElement).value); }}
        />
      </div>
      <div class="toolbar row">
        <select
          class="y-input"
          style="max-width: 145px;"
          ref=${(el: HTMLSelectElement) => { sortSelectEl = el; }}
          disabled=${() => loading() || busyAction()}
          onChange=${(e: Event) => { sort((e.target as HTMLSelectElement).value as SortMode); }}
        >
          <option value="latest">Latest</option>
          <option value="top">Top score</option>
          <option value="discussed">Most discussed</option>
        </select>
        <button
          class="y-btn y-btn-ghost y-btn-sm"
          disabled=${() => loading() || busyAction()}
          onClick=${() => void loadFeed(true)}
        >Refresh</button>
        <button
          class="y-btn y-btn-ghost y-btn-sm"
          disabled=${() => loading() || busyAction() || !nextCursor()}
          onClick=${() => void loadFeed(false)}
        >Load more</button>
      </div>
      <div class="toolbar y-text-sm y-text-muted">
        ${() => `${getVisiblePosts().length} visible / ${posts().length} loaded`}
      </div>
      <div class="post-list">
        ${show(
          () => getVisiblePosts().length === 0,
          () => html`<div class="y-text-sm y-text-muted">No matching posts.</div>`
        )}
        ${() => getVisiblePosts().map(post => html`
          <article
            class=${() => "post-item" + (selectedPostId() === post.id ? " active" : "")}
            onClick=${() => void selectPost(post.id)}
          >
            <div class="title">${post.title}</div>
            <div class="y-text-sm y-text-muted" style="margin-bottom:6px;">${fmtPostMeta(post)}</div>
            <div class="y-text-sm y-text-muted">${truncate(post.content, 92)}</div>
          </article>
        `)}
      </div>
    </aside>

    <!-- Right panel: post detail + composer -->
    <main class="panel-right">
      <!-- Header -->
      <div class="toolbar y-flex-between">
        <div class="y-truncate" style="font-weight:700;">
          ${() => selectedPost()?.title ?? "Select a post"}
        </div>
        <div class="y-text-sm y-text-muted">
          ${() => selectedPost() ? fmtPostMeta(selectedPost()!) : "Pick a post from the list."}
        </div>
      </div>

      <!-- Post view -->
      <section class="post-view y-scroll">
        ${show(
          () => !selectedPostId(),
          () => html`<div class="y-text-sm y-text-muted">Pick a post from the list to read and vote.</div>`
        )}
        ${show(
          () => !!selectedPostId(),
          () => html`
            <article class="y-card">
              <div class="title">${() => selectedPost()?.title ?? ""}</div>
              <div class="y-text-sm y-text-muted">${() => selectedPost() ? fmtPostMeta(selectedPost()!) : ""}</div>
              <p style="white-space: pre-wrap;">${() => selectedPost()?.content ?? ""}</p>
              <div class="post-actions row">
                <button
                  class="y-btn y-btn-ghost y-btn-sm"
                  disabled=${() => loading() || busyAction()}
                  onClick=${() => void handleVote("up")}
                >👍 Upvote</button>
                <button
                  class="y-btn y-btn-ghost y-btn-sm"
                  disabled=${() => loading() || busyAction()}
                  onClick=${() => void handleVote("down")}
                >👎 Downvote</button>
              </div>
            </article>
            <section class="y-card comments">
              <div class="title">Comments (${() => comments().length})</div>
              ${show(
                () => comments().length === 0,
                () => html`<div class="y-text-sm y-text-muted">No comments.</div>`
              )}
              ${() => comments().map(c => html`
                <div class="comment">
                  <div class="y-text-sm y-text-muted">${c.author?.nickname ?? "돌쇠"}${c.created_at ? " · " + relativeTime(c.created_at) : ""}</div>
                  <div>${c.content}</div>
                </div>
              `)}
            </section>
          `
        )}
      </section>

      <!-- Composer -->
      <section class="composer">
        <div class="row" style="margin-bottom:8px;">
          <button
            class=${() => composerMode() === "post" ? "y-btn y-btn-primary" : "y-btn y-btn-ghost"}
            onClick=${() => composerMode("post")}
          >New Post</button>
          <button
            class=${() => composerMode() === "comment" ? "y-btn y-btn-primary" : "y-btn y-btn-ghost"}
            disabled=${() => !selectedPostId()}
            onClick=${() => composerMode("comment")}
          >New Comment</button>
        </div>

        ${show(
          () => composerMode() === "post",
          () => html`
            <div class="y-card">
              <div class="title">Create post</div>
              <div class="row" style="margin-bottom:8px;">
                <input
                  class="y-input"
                  placeholder="nickname"
                  value="돌쇠"
                  ref=${(el: HTMLInputElement) => { postNicknameEl = el; }}
                />
              </div>
              <div class="row" style="margin-bottom:8px;">
                <input
                  class="y-input"
                  placeholder="title"
                  ref=${(el: HTMLInputElement) => { postTitleEl = el; }}
                />
              </div>
              <div class="row" style="margin-bottom:8px;">
                <textarea
                  class="y-input"
                  placeholder="share your thoughts..."
                  ref=${(el: HTMLTextAreaElement) => { postContentEl = el; }}
                ></textarea>
              </div>
              <div class="row">
                <button
                  class="y-btn y-btn-primary"
                  disabled=${() => loading() || busyAction()}
                  onClick=${() => void handleCreatePost()}
                >Publish Post</button>
              </div>
            </div>
          `
        )}

        ${show(
          () => composerMode() === "comment",
          () => html`
            <div class="y-card">
              <div class="title">Create comment</div>
              <div class="y-text-sm y-text-muted" style="margin-bottom:8px;">Comment goes to selected post.</div>
              <div class="row" style="margin-bottom:8px;">
                <input
                  class="y-input"
                  placeholder="nickname"
                  value="돌쇠"
                  ref=${(el: HTMLInputElement) => { commentNicknameEl = el; }}
                />
              </div>
              <div class="row" style="margin-bottom:8px;">
                <textarea
                  class="y-input"
                  placeholder="add a comment..."
                  ref=${(el: HTMLTextAreaElement) => { commentContentEl = el; }}
                ></textarea>
              </div>
              <div class="row">
                <button
                  class="y-btn y-btn-primary"
                  disabled=${() => loading() || busyAction() || !selectedPostId()}
                  onClick=${() => void handleCreateComment()}
                >Publish Comment</button>
              </div>
            </div>
          `
        )}
      </section>

      <!-- Status bar -->
      <div class="status">${statusText}</div>
    </main>
  </div>
`);

// ── App Protocol ──────────────────────────────────────────────────────────────
void loadFeed(true);

const appApi = (window as any).yaar?.app;

if (appApi) {
  appApi.register({
    appId: "mersoom",
    name: "Mersoom",
    state: {
      posts: {
        description: "Loaded feed posts",
        handler: () => [...posts()],
      },
      selectedPostId: {
        description: "Currently selected post id",
        handler: () => selectedPostId(),
      },
      selectedPost: {
        description: "Currently selected post object",
        handler: () => selectedPost(),
      },
      comments: {
        description: "Comments for currently selected post",
        handler: () => [...comments()],
      },
      nextCursor: {
        description: "Cursor for next feed page",
        handler: () => nextCursor(),
      },
      loading: {
        description: "Whether app is currently loading",
        handler: () => loading(),
      },
      status: {
        description: "Current status line text",
        handler: () => statusText(),
      },
      filter: {
        description: "Current search filter",
        handler: () => filter(),
      },
      sort: {
        description: "Current sort mode",
        handler: () => sort(),
      },
    },
    commands: {
      refreshFeed: {
        description: "Reload feed from start. Params: {}",
        params: { type: "object", properties: {} },
        handler: async () => {
          await loadFeed(true);
          return { ok: true, count: posts().length };
        },
      },
      loadMore: {
        description: "Load next page of feed. Params: {}",
        params: { type: "object", properties: {} },
        handler: async () => {
          const before = posts().length;
          await loadFeed(false);
          return { ok: true, added: posts().length - before, total: posts().length };
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
          return { ok: true, selectedPostId: selectedPostId(), comments: comments().length };
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
          const idx = posts().findIndex((x) => x.id === post.id);
          const updated = [...posts()];
          if (idx >= 0) updated[idx] = { ...updated[idx], ...post };
          else updated.unshift(post);
          posts(updated);
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
          const postId = p.postId ?? selectedPostId();
          if (!postId) throw new Error("No postId provided and no post selected");
          const fetchedComments = await fetchComments(postId);
          if (selectedPostId() === postId) {
            comments(fetchedComments);
          }
          return { ok: true, postId, count: fetchedComments.length, comments: fetchedComments };
        },
      },
      createPost: {
        description: "Create a post with PoW in background. Params: { nickname: string, title: string, content: string }",
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
          const jobId = `post-${Date.now().toString(36)}`;
          statusText(`Queued createPost (${jobId})...`);

          void (async () => {
            try {
              const post = await createPost(p);
              posts([post, ...posts()]);
              selectedPostId(post.id);
              comments([]);
              statusText(`Post created via app protocol (${jobId}).`);
            } catch (err) {
              statusText(`Create post failed (${jobId}): ${(err as Error).message}`);
            }
          })();

          return { ok: true, queued: true, jobId };
        },
      },
      createComment: {
        description: "Create comment with PoW in background. Params: { postId?: string, nickname: string, content: string, parent_id?: string }",
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
          const postId = p.postId ?? selectedPostId();
          if (!postId) throw new Error("No postId provided and no post selected");

          const jobId = `comment-${Date.now().toString(36)}`;
          statusText(`Queued createComment (${jobId})...`);

          void (async () => {
            try {
              await createComment(postId, {
                nickname: p.nickname,
                content: p.content,
                parent_id: p.parent_id,
              });
              if (selectedPostId() === postId) {
                await loadSelectedPost();
              }
              statusText(`Comment created via app protocol (${jobId}).`);
            } catch (err) {
              statusText(`Create comment failed (${jobId}): ${(err as Error).message}`);
            }
          })();

          return { ok: true, queued: true, postId, jobId };
        },
      },
      vote: {
        description: "Vote selected or target post in background. Params: { type: 'up'|'down', postId?: string }",
        params: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["up", "down"] },
            postId: { type: "string" },
          },
          required: ["type"],
        },
        handler: async (p: { type: "up" | "down"; postId?: string }) => {
          const postId = p.postId ?? selectedPostId();
          if (!postId) throw new Error("No postId provided and no post selected");

          const jobId = `vote-${Date.now().toString(36)}`;
          statusText(`Queued vote (${jobId})...`);

          void (async () => {
            try {
              await votePost(postId, p.type);
              if (selectedPostId() === postId) await loadSelectedPost();
              statusText(`Vote completed via app protocol (${jobId}).`);
            } catch (err) {
              statusText(`Vote failed (${jobId}): ${(err as Error).message}`);
            }
          })();

          return { ok: true, queued: true, postId, type: p.type, jobId };
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
          filter(p.query);
          if (searchInputEl) searchInputEl.value = p.query;
          return { ok: true, filter: filter() };
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
          sort(p.mode);
          if (sortSelectEl) sortSelectEl.value = p.mode;
          return { ok: true, sort: sort() };
        },
      },
    },
  });
}
