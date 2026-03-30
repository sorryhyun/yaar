import { state, setState, settings, updatePosts } from './store';
import { fetchPosts, fetchPostDetail, fetchTopPostsForAnalysis } from './fetcher';
import { app, withLoading, showToast, errMsg } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';
import { POST_TAB, syncCookiesToTab } from './browser';
import type { Post } from './types';
import {
  loginToDC,
  logoutFromDC,
  checkLoginStatus,
  postCommentToDC,
  loadSession,
} from './auth';

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let fetchVersion = 0;

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
      const newPosts = await fetchPosts(state.page);
      updatePosts(newPosts);
      setState('countdown', settings().refreshInterval);
    },
    (msg) => setState('error', msg || '불러오기 실패'),
  );
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

  try {
    const { content, comments } = await fetchPostDetail(post);
    if (version !== fetchVersion) return;
    setState({ postContent: content, comments });
  } catch (e: unknown) {
    if (version !== fetchVersion) return;
    const msg = e instanceof Error ? e.message : String(e);
    setState(
      'postContent',
      `<p style="color:var(--yaar-error)">게시물을 불러올 수 없습니다: ${msg}</p>`,
    );
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
    await syncCookiesToTab(POST_TAB);
    const result = await postCommentToDC(post, text, POST_TAB);
    if (result.ok) {
      setState('commentText', '');
      showToast('💬 댓글이 등록되었습니다!', 'success');
      try {
        const { comments } = await fetchPostDetail(post);
        setState('comments', comments);
      } catch { /* 실패해도 무시 */ }
    } else {
      showToast(result.error ?? '댓글 작성 실패', 'error');
    }
  } catch (e: unknown) {
    showToast(errMsg(e), 'error');
  } finally {
    setState('commentSubmitting', false);
  }
}
