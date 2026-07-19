import { state, setState, settings, updatePosts } from './store';
import {
  fetchPosts,
  fetchSearchResults,
  fetchPostDetail,
  fetchPostBody,
  fetchPostComments,
  fetchTopPostsForAnalysis,
  inlineRemoteImages,
} from './fetcher';
import type { SearchType } from './types';
import { app, withLoading, showToast, errMsg } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';
import { POST_TAB, WRITE_TAB } from './browser';
import type { Post, Comment } from './types';
import {
  loginToDC,
  logoutFromDC,
  checkLoginStatus,
  postCommentToDC,
  postNewPostToDC,
  loadSession,
} from './auth';

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let fetchVersion = 0;

// In-memory cache for post detail results (body HTML + parsed comments).
// Keyed by post.id; entries older than POST_CACHE_TTL are ignored. This avoids
// re-fetching when a user re-clicks an already-viewed post.
type CachedDetail = { content: string; comments: Comment[]; ts: number };
const POST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const POST_CACHE_MAX = 80;
const postDetailCache = new Map<string, CachedDetail>();

function cacheGet(id: string): CachedDetail | null {
  const hit = postDetailCache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.ts > POST_CACHE_TTL) {
    postDetailCache.delete(id);
    return null;
  }
  return hit;
}

function cacheSet(id: string, content: string, comments: Comment[]): void {
  if (postDetailCache.size >= POST_CACHE_MAX) {
    // Evict the oldest entry to keep the map bounded
    const firstKey = postDetailCache.keys().next().value;
    if (firstKey) postDetailCache.delete(firstKey);
  }
  postDetailCache.set(id, { content, comments, ts: Date.now() });
}

export function clearTimers(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);
}

export async function doRefresh(): Promise<void> {
  if (state.loading) return;
  setState('error', null);
  await withLoading(
    (v: boolean) => setState('loading', v),
    async () => {
      if (state.searchActive) {
        const results = await fetchSearchResults(
          state.searchKeyword,
          state.searchType,
          state.page,
        );
        // Search results bypass new-post tracking.
        setState({ posts: results, newPostCount: 0, lastUpdated: new Date() });
      } else {
        const newPosts = await fetchPosts(state.page);
        updatePosts(newPosts);
      }
      setState('countdown', settings().refreshInterval);
    },
    (msg) => setState('error', msg || '불러오기 실패'),
  );
}

/** Run an in-gallery search. Empty keyword falls back to the normal list. */
export async function doSearch(keyword?: string, sType?: SearchType): Promise<void> {
  const kw = (keyword ?? state.searchKeyword).trim();
  if (sType) setState('searchType', sType);
  if (!kw) {
    await clearSearch();
    return;
  }
  setState({
    searchKeyword: kw,
    searchActive: true,
    page: 1,
    posts: [],
    selectedCategory: null,
    filterKeyword: null,
  });
  await doRefresh();
}

/** Exit search mode and return to the normal gallery list. */
export async function clearSearch(): Promise<void> {
  setState({ searchActive: false, searchKeyword: '', page: 1 });
  await doRefresh();
}

export async function goToPage(page: number): Promise<void> {
  if (page < 1 || state.loading) return;
  setState('page', page);
  await doRefresh();
}

export function startRefreshTimer(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);

  const interval = settings().refreshInterval;
  setState('countdown', interval);

  refreshTimer = setInterval(() => doRefresh(), interval * 1000);

  countdownTimer = setInterval(() => {
    setState('countdown', (c) => (c <= 1 ? settings().refreshInterval : c - 1));
  }, 1000);
}

export async function selectPost(post: Post): Promise<void> {
  if (state.selectedPost?.id === post.id && state.postContent) return;

  // ——— Cache hit: instant render ———
  const cached = cacheGet(post.id);
  if (cached) {
    ++fetchVersion;
    setState({
      selectedPost: post,
      postContent: cached.content,
      postLoading: false,
      showOriginal: false,
      screenshotSrc: null,
      screenshotLoading: false,
      comments: cached.comments,
      commentsLoading: false,
      showComments: false,
      commentText: '',
    });
    return;
  }

  const version = ++fetchVersion;
  setState({
    selectedPost: post,
    postContent: null,
    postLoading: true,
    showOriginal: false,
    screenshotSrc: null,
    screenshotLoading: false,
    comments: [],
    commentsLoading: true,
    showComments: false,
    commentText: '',
  });

  // ——— Body: HTTP path (server-side proxy, images inlined). Primary + fast. ———
  const bodyPromise = fetchPostBody(post).catch(() => null);

  // ——— Comments: browser (the only read that needs JS/AJAX). Also returns a
  // raw body snapshot, used only as a fallback if the HTTP body fails. Hard-
  // capped so a hung headless tab can't leave the UI spinning forever. ———
  const browserPromise = Promise.race([
    fetchPostComments(post),
    new Promise<{ comments: Comment[]; bodyHtmlRaw: string }>((resolve) =>
      setTimeout(() => resolve({ comments: [], bodyHtmlRaw: '' }), 20000),
    ),
  ]).catch(() => ({ comments: [] as Comment[], bodyHtmlRaw: '' }));

  // Render the body the moment HTTP returns it — don't wait on the browser.
  bodyPromise.then((body) => {
    if (version !== fetchVersion) return;
    if (body && state.postLoading) setState({ postContent: body, postLoading: false });
  });

  try {
    const [body, browser] = await Promise.all([bodyPromise, browserPromise]);
    if (version !== fetchVersion) return;

    let content = body;
    if (!content && browser.bodyHtmlRaw) {
      content = await inlineRemoteImages(browser.bodyHtmlRaw);
    }
    if (!content) {
      content =
        '<p style="color:var(--yaar-error)">게시물을 불러오는 데 실패했습니다. 다시 시도해주세요.</p>';
    }

    setState({ postContent: content, comments: browser.comments });
    cacheSet(post.id, content, browser.comments);
  } catch (e: unknown) {
    if (version !== fetchVersion) return;
    const msg = errMsg(e);
    if (!state.postContent) {
      setState(
        'postContent',
        `<p style="color:var(--yaar-error)">게시물을 불러올 수 없습니다: ${msg}</p>`,
      );
    }
  } finally {
    if (version === fetchVersion) setState({ postLoading: false, commentsLoading: false });
  }
}

export async function triggerAnalysis(): Promise<void> {
  if (state.recLoading) return;
  const currentPosts = state.posts;
  if (currentPosts.length === 0) return;

  setState('recLoading', true);
  try {
    const topPostsData = await fetchTopPostsForAnalysis(currentPosts, 5);
    app.sendInteraction({
      type: 'analyze_posts',
      description: '게시물 목록과 상위 주제 게시물 내용을 분석하여 setRecommendations 코맨드로 결과를 돌려주세요',
      allPosts: currentPosts.map((p) => ({
        num: p.num, title: p.title, author: p.author,
        views: p.views, recommend: p.recommend, category: p.category ?? null,
      })),
      topPosts: topPostsData.map(({ post, text }) => ({
        num: post.num, title: post.title, views: post.views,
        recommend: post.recommend, contentText: text,
      })),
    });
  } catch (e: unknown) {
    console.error('Analysis trigger failed:', e);
    setState('recLoading', false);
  }
}

export async function takeScreenshot(_post: Post): Promise<void> {
  setState({ screenshotLoading: true, screenshotSrc: null });
  try {
    const result = await web.screenshot({ browserId: POST_TAB }) as {
      ok: boolean; images?: Array<{ data: string; mimeType?: string }>;
    };
    const images = result?.images ?? [];
    if (images.length > 0) {
      const img = images[0];
      setState('screenshotSrc', `data:${img.mimeType ?? 'image/png'};base64,${img.data}`);
    }
  } catch (e: unknown) {
    console.error('Screenshot failed:', e);
  } finally {
    setState('screenshotLoading', false);
  }
}

/** Restore login state from saved session on app startup */
export async function initLoginStatus(): Promise<void> {
  try {
    const session = await loadSession();
    if (!session?.dcPaPP) {
      setState('isLoggedIn', false);
      return;
    }

    if (session.username && !state.savedCredentials?.username) {
      setState('savedCredentials', {
        username: session.username,
        password: state.savedCredentials?.password ?? '',
        savedAt: session.savedAt,
      });
    }

    setState('loginLoading', true);
    const ok = await checkLoginStatus();
    setState({ isLoggedIn: ok, loginLoading: false });

    if (ok) {
      showToast(`🔓 자동 로그인됨 (${session.username})`, 'success', 3000);
    }
  } catch {
    setState({ isLoggedIn: false, loginLoading: false });
  }
}

export async function doLogin(username?: string, password?: string): Promise<void> {
  const u = username ?? state.savedCredentials?.username ?? '';
  const p = password ?? state.savedCredentials?.password ?? '';

  if (!u) {
    showToast('아이디를 입력해주세요', 'error');
    return;
  }

  setState('loginLoading', true);
  try {
    const result = await loginToDC(u, p);
    if (result.ok) {
      setState('isLoggedIn', true);
      showToast(`🔓 로그인 성공! (${u})`, 'success');
    } else {
      setState('isLoggedIn', false);
      showToast(result.error ?? '로그인 실패', 'error');
    }
  } catch (e: unknown) {
    setState('isLoggedIn', false);
    showToast(errMsg(e), 'error');
  } finally {
    setState('loginLoading', false);
  }
}

export async function doLogout(): Promise<void> {
  setState('loginLoading', true);
  try {
    await logoutFromDC();
    setState('isLoggedIn', false);
    showToast('로그아웃 완료', 'success');
  } catch (e: unknown) {
    showToast(errMsg(e), 'error');
  } finally {
    setState('loginLoading', false);
  }
}

export async function submitComment(): Promise<void> {
  const post = state.selectedPost;
  if (!post) return;
  const text = state.commentText.trim();
  if (!text) {
    showToast('댓글 내용을 입력해주세요', 'error');
    return;
  }
  if (!state.isLoggedIn) {
    showToast('로그인이 필요합니다', 'error');
    return;
  }

  setState('commentSubmitting', true);
  try {
    // postCommentToDC is self-contained: it ensures the post tab exists,
    // applies login cookies, reloads, fills and submits.
    const result = await postCommentToDC(post, text, POST_TAB);
    if (result.ok) {
      setState('commentText', '');
      showToast('💬 댓글이 등록되었습니다!', 'success');
      // Invalidate cached comments for this post so the refetch isn't shadowed
      postDetailCache.delete(post.id);
      try {
        const { content, comments } = await fetchPostDetail(post);
        cacheSet(post.id, content, comments);
        setState({ comments, postContent: content });
      } catch { /* 실패해도 무시 */ }
    } else {
      console.error('[submitComment] failed:', result.error);
      showToast(result.error ?? '댓글 작성 실패', 'error');
    }
  } catch (e: unknown) {
    console.error('[submitComment] unexpected error:', e);
    showToast(errMsg(e), 'error');
  } finally {
    setState('commentSubmitting', false);
  }
}

export async function submitPost(): Promise<void> {
  const title = state.writeTitle.trim();
  const content = state.writeContent.trim();
  if (!state.isLoggedIn) {
    showToast('로그인이 필요합니다', 'error');
    return;
  }
  if (!title) {
    showToast('제목을 입력해주세요', 'error');
    return;
  }
  if (!content) {
    showToast('본문을 입력해주세요', 'error');
    return;
  }

  setState('writeSubmitting', true);
  try {
    const result = await postNewPostToDC(
      { title, content, category: state.writeCategory ?? undefined },
      WRITE_TAB,
    );
    if (result.ok) {
      showToast('✏️ 게시물이 등록되었습니다!', 'success');
      setState({
        showWrite: false,
        writeTitle: '',
        writeContent: '',
        writeCategory: null,
      });
      // Jump to first page and refresh so the new post appears at the top.
      setState('page', 1);
      await doRefresh();
    } else {
      console.error('[submitPost] failed:', result.error);
      showToast(result.error ?? '게시물 등록 실패', 'error');
    }
  } catch (e: unknown) {
    console.error('[submitPost] unexpected error:', e);
    showToast(errMsg(e), 'error');
  } finally {
    setState('writeSubmitting', false);
  }
}
