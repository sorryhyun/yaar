import { state, setState, settings, updatePosts } from './store';
import { fetchPosts, fetchPostDetail, fetchTopPostsForAnalysis } from './fetcher';
import { app, withLoading } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';
import type { Post } from './types';
import { toMobileUrl } from './helpers';

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let fetchVersion = 0;

/** 타이머를 모두 정지 (열림 시 cleanup) */
export function clearTimers(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);
}

/** 게시물 목록을 지금 증해서 가져온다 */
export async function doRefresh(): Promise<void> {
  if (state.loading) return;
  setState('error', null);
  await withLoading(
    (v: boolean) => setState('loading', v),
    async () => {
      const newPosts = await fetchPosts();
      updatePosts(newPosts);
      setState('countdown', settings().refreshInterval);
    },
    (msg) => {
      setState('error', msg || '불러오기 실패');
    },
  );
}

/** 자동 새로고침 타이머를 시작한다 */
export function startRefreshTimer(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);

  const interval = settings().refreshInterval;
  setState('countdown', interval);

  refreshTimer = setInterval(() => {
    doRefresh();
  }, interval * 1000);

  countdownTimer = setInterval(() => {
    setState('countdown', (c) => {
      if (c <= 1) return settings().refreshInterval;
      return c - 1;
    });
  }, 1000);
}

/**
 * 게시물을 선택하고 본문과 댓글을 동시에 비동기로 가져온다.
 */
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
  });

  try {
    const { content, comments } = await fetchPostDetail(post);
    if (version !== fetchVersion) return;
    setState({ postContent: content, comments });
  } catch (e: any) {
    if (version !== fetchVersion) return;
    setState(
      'postContent',
      '<p style="color:var(--yaar-error)">게시물을 불러올 수 없습니다: ' +
        (e?.message ?? '') +
        '</p>',
    );
  } finally {
    if (version === fetchVersion) {
      setState({ postLoading: false, commentsLoading: false });
    }
  }
}

/** AI 분석 트리거: 상위 5개 게시물 내용을 에이전트에게 전달 */
export async function triggerAnalysis(): Promise<void> {
  if (state.recLoading) return;
  const currentPosts = state.posts;
  if (currentPosts.length === 0) return;

  setState('recLoading', true);
  try {
    const topPostsData = await fetchTopPostsForAnalysis(currentPosts, 5);
    app.sendInteraction({
      type: 'analyze_posts',
      description:
        '게시물 목록과 상위 주제 게시물 내용을 분석하여 setRecommendations 커맨드로 결과를 돌려주세요',
      allPosts: currentPosts.map((p) => ({
        num: p.num,
        title: p.title,
        author: p.author,
        views: p.views,
        recommend: p.recommend,
        category: p.category ?? null,
      })),
      topPosts: topPostsData.map(({ post, text }) => ({
        num: post.num,
        title: post.title,
        views: post.views,
        recommend: post.recommend,
        contentText: text,
      })),
    });
  } catch (e: any) {
    console.error('Analysis trigger failed:', e);
    setState('recLoading', false);
  }
}

/** 모바일 브라우저로 포스트 URL 스크린셛 찍기 */
export async function takeScreenshot(post: Post): Promise<void> {
  setState({ screenshotLoading: true, screenshotSrc: null });
  try {
    const mobileUrl = toMobileUrl(post.url);
    await web.open(mobileUrl, {
      browserId: 'pages',
      visible: false,
      mobile: true,
      waitUntil: 'networkidle',
    });
    await web.scroll({ direction: 'down', browserId: 'pages' });
    const result = await web.screenshot({ browserId: 'pages' }) as {
      ok: boolean;
      images?: Array<{ data: string; mimeType?: string }>;
    };
    const images = result?.images ?? [];
    if (images.length > 0) {
      const img = images[0];
      setState('screenshotSrc', `data:${img.mimeType ?? 'image/png'};base64,${img.data}`);
    }
  } catch (e: any) {
    console.error('Screenshot failed:', e);
  } finally {
    setState('screenshotLoading', false);
  }
}
