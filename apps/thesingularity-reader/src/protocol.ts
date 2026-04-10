import { state, setState } from './store';
import { app, AppCommandError } from '@bundled/yaar';
import { saveCredentials, loadCredentials } from './credentials';
import { selectPost } from './actions';

/** Strip HTML tags and collapse whitespace for agent-readable text */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'thesingularity-reader',
    name: '특이점이 온다',
    state: {
      credentials: {
        description: '저장된 자격증명 (username, savedAt). 비밀번호는 노출안 함.',
        handler: () =>
          state.savedCredentials
            ? { username: state.savedCredentials.username, savedAt: state.savedCredentials.savedAt }
            : null,
      },
      posts: {
        description: '현재 로드된 게시물 목록 (num, title, author, category, views, recommend)',
        handler: () =>
          state.posts.map((p) => ({
            num: p.num,
            title: p.title,
            author: p.author,
            category: p.category ?? null,
            views: p.views,
            recommend: p.recommend,
            date: p.date,
          })),
      },
      selectedPost: {
        description: '현재 선택된 게시물의 상세 정보 (메타데이터 + 본문 텍스트 + 댓글)',
        handler: () => {
          if (!state.selectedPost) return null;
          if (state.postLoading) return { loading: true, num: state.selectedPost.num };
          return {
            num: state.selectedPost.num,
            title: state.selectedPost.title,
            author: state.selectedPost.author,
            category: state.selectedPost.category ?? null,
            views: state.selectedPost.views,
            recommend: state.selectedPost.recommend,
            content: state.postContent ? htmlToText(state.postContent) : null,
            comments: state.comments.map((c) => ({
              author: c.author,
              text: c.text,
              recommend: c.recommend,
              isBest: c.isBest,
            })),
          };
        },
      },
    },
    commands: {
      saveCredentials: {
        description: '아이디/비밀번호를 앱 스토리지(auth/credentials.json)에 저장합니다.',
        params: {
          type: 'object',
          properties: {
            username: { type: 'string', description: '저장할 아이디' },
            password: { type: 'string', description: '저장할 비밀번호 (평문)' },
          },
          required: ['username', 'password'],
        },
        handler: async (p: Record<string, unknown>) => {
          const creds = await saveCredentials(p.username as string, p.password as string);
          setState('savedCredentials', creds);
          return { username: creds.username, savedAt: creds.savedAt };
        },
      },
      loadCredentials: {
        description: '저장된 자격증명을 불러옵니다. 없으면 에러를 던집니다.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          const creds = await loadCredentials();
          if (!creds) throw new AppCommandError('저장된 자격증명 없음');
          setState('savedCredentials', creds);
          return { username: creds.username, savedAt: creds.savedAt };
        },
      },
      selectPost: {
        description: '게시물 번호로 게시물을 선택하고 본문+댓글을 로드합니다. 완료 후 selectedPost 상태를 조회하세요.',
        params: {
          type: 'object',
          properties: {
            num: { type: 'string', description: '게시물 번호' },
          },
          required: ['num'],
        },
        handler: async (p: Record<string, unknown>) => {
          const num = p.num as string;
          const post = state.posts.find((pt) => pt.num === num);
          if (!post) throw new AppCommandError(`게시물 ${num}을 찾을 수 없습니다`);
          await selectPost(post);
          return { ok: true, num };
        },
      },
      setRecommendations: {
        description: 'AI 분석 결과를 앱에 반영합니다. topics는 현재 뜨는 주제 키워드 목록(5~8개), bestPost는 오늘의 베스트 게시물 번호와 추천 이유',
        params: {
          type: 'object',
          properties: {
            topics: {
              type: 'array',
              items: { type: 'string' },
              description: '현재 뜨는 주제 키워드/문구 목록 (5~8개)',
            },
            bestPost: {
              type: 'object',
              description: '오늘의 베스트 게시물 (딱 1개)',
              properties: {
                num: { type: 'string', description: '게시물 번호' },
                reason: { type: 'string', description: 'AI 추천 이유 (2~3문장)' },
              },
              required: ['num', 'reason'],
            },
          },
          required: ['topics'],
        },
        handler: (p: Record<string, unknown>) => {
          const topics = p.topics as string[];
          const bestPost = p.bestPost as { num: string; reason: string } | undefined;
          setState('recLoading', false);
          setState('recommendation', {
            topics,
            bestPostNum: bestPost?.num ?? null,
            bestPostReason: bestPost?.reason ?? null,
            analyzedAt: new Date(),
          });
        },
      },
    },
  });
}
