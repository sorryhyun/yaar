import { state } from './store';
import { app, AppCommandError, defineCommand } from '@bundled/yaar';
import {
  doRefresh,
  setTab,
  selectPost,
  subscribeSeries,
  unsubscribeSeries,
  refreshAllSubs,
} from './actions';

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'dc-comics',
    name: 'DC 만화 갤러리',
    state: {
      feed: {
        description: '현재 피드 상태 (탭, 페이지, 글 수, 마지막 갱신 시각, 새 글 수).',
        handler: () => ({
          tab: state.tabMode,
          page: state.page,
          postCount: state.posts.length,
          newPostCount: state.newPostCount,
          lastUpdated: state.lastUpdated ? state.lastUpdated.toISOString() : null,
          posts: state.posts.map((p) => ({
            num: p.num,
            title: p.title,
            author: p.author,
            views: p.views,
            recommend: p.recommend,
            comments: p.comments,
            category: p.category ?? null,
          })),
        }),
      },
      selectedPost: {
        description:
          '현재 선택된 게시물 (없으면 null). 본문 로딩 상태와 본문에 포함된 이미지 수/텍스트 미리보기를 함께 반환하므로, 본문이 제대로 파싱됐는지 확인할 수 있습니다.',
        handler: () => {
          const post = state.selectedPost;
          if (!post) return null;
          const content = state.postContent;
          let imageCount = 0;
          let textPreview = '';
          if (content) {
            try {
              const doc = new DOMParser().parseFromString(content, 'text/html');
              imageCount = doc.querySelectorAll('img').length;
              textPreview = (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
            } catch {
              // Leave the defaults; a parse failure is itself visible as imageCount 0.
            }
          }
          return {
            num: post.num,
            title: post.title,
            url: post.url,
            loading: state.postLoading,
            error: state.postError,
            hasContent: !!content,
            imageCount,
            textPreview,
          };
        },
      },
      comments: {
        description: '현재 선택된 게시물의 댓글 목록.',
        handler: () => ({
          count: state.comments.length,
          items: state.comments.map((c) => ({
            author: c.author,
            text: c.text,
            date: c.date,
            recommend: c.recommend,
            isBest: c.isBest,
            isReply: c.isReply,
          })),
        }),
      },
      subscriptions: {
        description: '구독 중인 시리즈 목록과 각 시리즈의 안 읽은 글 수.',
        handler: () =>
          state.subscriptions.map((s) => ({
            id: s.id,
            title: s.title,
            gallId: s.gallId,
            unreadCount: s.unreadCount,
          })),
      },
    },
    commands: {
      refresh: defineCommand({
        description: '현재 탭/페이지의 글 목록을 새로고침합니다.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await doRefresh();
          return { ok: true, postCount: state.posts.length };
        },
      }),
      setTab: defineCommand({
        description: "피드 탭을 전환합니다. mode는 'all'(전체글) 또는 'recommend'(개념글).",
        params: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['all', 'recommend'], description: '전환할 탭' },
          },
          required: ['mode'],
        },
        handler: (p) => {
          const mode = p.mode;
          if (mode !== 'all' && mode !== 'recommend') {
            throw new AppCommandError("mode는 'all' 또는 'recommend'여야 합니다");
          }
          setTab(mode);
          return { ok: true, tab: mode };
        },
      }),
      selectPost: defineCommand({
        description:
          '현재 목록에서 글 번호(num)로 게시물을 선택해 본문과 댓글을 불러옵니다. 목록에 없는 번호면 에러를 던집니다.',
        params: {
          type: 'object',
          properties: {
            num: { type: 'string', description: '선택할 게시물 번호' },
          },
          required: ['num'],
        },
        handler: async (p) => {
          const num = String(p.num ?? '').trim();
          if (!num) throw new AppCommandError('게시물 번호가 비어 있습니다');
          const post = state.posts.find((x) => x.num === num);
          if (!post) throw new AppCommandError(`현재 목록에 ${num}번 게시물이 없습니다`);
          await selectPost(post);
          return { ok: true, num, title: post.title, commentCount: state.comments.length };
        },
      }),
      subscribeSeries: defineCommand({
        description: '시리즈를 구독합니다. title(시리즈 제목)과 url(시리즈 목록 URL)이 필요합니다.',
        params: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '시리즈 제목' },
            url: { type: 'string', description: '시리즈 목록 URL' },
          },
          required: ['title', 'url'],
        },
        handler: async (p) => {
          const title = typeof p.title === 'string' ? p.title.trim() : '';
          const url = typeof p.url === 'string' ? p.url.trim() : '';
          if (!title) throw new AppCommandError('제목이 비어 있습니다');
          if (!url) throw new AppCommandError('URL이 비어 있습니다');
          await subscribeSeries({ title, url });
          return { ok: true, count: state.subscriptions.length };
        },
      }),
      unsubscribeSeries: defineCommand({
        description: '구독 중인 시리즈를 id로 구독 취소합니다.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '구독 id' },
          },
          required: ['id'],
        },
        handler: async (p) => {
          const id = String(p.id ?? '').trim();
          if (!id) throw new AppCommandError('구독 id가 비어 있습니다');
          await unsubscribeSeries(id);
          return { ok: true, count: state.subscriptions.length };
        },
      }),
      refreshSubscriptions: defineCommand({
        description: '구독 중인 모든 시리즈의 새 글을 확인하고 안 읽은 수를 갱신합니다.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await refreshAllSubs();
          const totalUnread = state.subscriptions.reduce((a, s) => a + s.unreadCount, 0);
          return { ok: true, totalUnread };
        },
      }),
    },
  });
}
