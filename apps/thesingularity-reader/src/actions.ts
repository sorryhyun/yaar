import { batch } from '@bundled/solid-js';
import {
  posts, loading, setLoading, setError,
  settings, setCountdown,
  selectedPost, setSelectedPost,
  postContent, setPostContent, setPostLoading,
  setShowOriginal, setScreenshotSrc, setScreenshotLoading,
  recLoading, setRecLoading,
  updatePosts,
  setComments, setCommentsLoading, setShowComments,
} from './store';
import { fetchPosts, fetchPostDetail, fetchTopPostsForAnalysis } from './fetcher';
import { app, invoke, withLoading } from '@bundled/yaar';
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
  if (loading()) return;
  setError(null);
  await withLoading(setLoading, async () => {
    const newPosts = await fetchPosts();
    updatePosts(newPosts);
    setCountdown(settings().refreshInterval);
  }, (msg) => {
    setError(msg || '불러오기 실패');
  });
}

/** 자동 새로고침 타이머를 시작한다 */
export function startRefreshTimer(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);

  const interval = settings().refreshInterval;
  setCountdown(interval);

  refreshTimer = setInterval(() => {
    doRefresh();
  }, interval * 1000);

  countdownTimer = setInterval(() => {
    setCountdown(c => {
      if (c <= 1) return settings().refreshInterval;
      return c - 1;
    });
  }, 1000);
}

/**
 * 게시물을 선택하고 본문과 댓글을 동시에 비동기로 가져온다.
 */
export async function selectPost(post: Post): Promise<void> {
  if (selectedPost()?.id === post.id && postContent()) return;

  const version = ++fetchVersion;
  batch(() => {
    setSelectedPost(post);
    setPostContent(null);
    setPostLoading(true);
    setShowOriginal(false);
    setScreenshotSrc(null);
    setScreenshotLoading(false);
    setComments([]);
    setCommentsLoading(true);
    setShowComments(false);
  });

  try {
    const { content, comments } = await fetchPostDetail(post);
    if (version !== fetchVersion) return;
    batch(() => {
      setPostContent(content);
      setComments(comments);
    });
  } catch (e: any) {
    if (version !== fetchVersion) return;
    setPostContent(
      '<p style="color:var(--yaar-error)">게시물을 불러올 수 없습니다: ' +
        (e?.message ?? '') +
        '</p>',
    );
  } finally {
    if (version === fetchVersion) {
      setPostLoading(false);
      setCommentsLoading(false);
    }
  }
}

/** AI 분석 트리거: 상위 5개 게시물 내용을 에이전트에게 전달 */
export async function triggerAnalysis(): Promise<void> {
  if (recLoading()) return;
  const currentPosts = posts();
  if (currentPosts.length === 0) return;

  setRecLoading(true);
  try {
    const topPostsData = await fetchTopPostsForAnalysis(currentPosts, 5);
    app.sendInteraction({
      type: 'analyze_posts',
      description:
        '게시물 목록과 상위 주제 게시물 내용을 분석하여 setRecommendations 커맨드로 결과를 돌려주세요',
      allPosts: currentPosts.map(p => ({
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
    setRecLoading(false);
  }
}

/** 모바일 브라우저로 포스트 URL 스크린셛 찍기 */
export async function takeScreenshot(post: Post): Promise<void> {
  batch(() => {
    setScreenshotLoading(true);
    setScreenshotSrc(null);
  });
  try {
    const mobileUrl = toMobileUrl(post.url);
    await invoke('yaar://browser/pages', {
      action: 'open',
      url: mobileUrl,
      visible: false,
      mobile: true,
      waitUntil: 'networkidle',
    });
    await invoke('yaar://browser/pages', { action: 'scroll', direction: 'down', y: 350 });
    const result = await invoke<{ data: string; images?: Array<{ data: string; mimeType?: string }> }>('yaar://browser/pages', { action: 'screenshot' });
    const images = result?.images ?? [];
    if (images.length > 0) {
      const img = images[0];
      setScreenshotSrc(`data:${img.mimeType ?? 'image/png'};base64,${img.data}`);
    }
  } catch (e: any) {
    console.error('Screenshot failed:', e);
  } finally {
    setScreenshotLoading(false);
  }
}
