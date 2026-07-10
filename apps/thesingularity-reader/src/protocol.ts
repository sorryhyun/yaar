import { state, setState } from './store';
import { app, AppCommandError, defineCommand } from '@bundled/yaar';
import { saveCredentials, loadCredentials } from './credentials';
import { submitComment, submitPost, doSearch, clearSearch } from './actions';

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
      loginStatus: {
        description: '현재 로그인 여부와 사용자명.',
        handler: () => ({
          isLoggedIn: state.isLoggedIn,
          username: state.savedCredentials?.username ?? null,
        }),
      },
      selectedPost: {
        description: '현재 선택된 게시물 (없으면 null).',
        handler: () =>
          state.selectedPost
            ? {
                num: state.selectedPost.num,
                title: state.selectedPost.title,
                url: state.selectedPost.url,
              }
            : null,
      },
      comments: {
        description: '현재 선택된 게시물의 댓글 목록. commentsLoading이 true면 아직 로딩 중.',
        handler: () => ({
          loading: state.commentsLoading,
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
      search: {
        description: '현재 검색 상태. searchActive가 true면 검색 결과를 보고 있음.',
        handler: () => ({
          active: state.searchActive,
          keyword: state.searchKeyword,
          type: state.searchType,
          page: state.page,
          resultCount: state.posts.length,
        }),
      },
    },
    commands: {
      search: defineCommand({
        description:
          '갤러리 내 검색을 실행합니다. keyword는 검색어, type은 검색 대상(subject_m=제목+내용, subject=제목, memo=내용, name=글쓴이, comment=댓글). keyword가 비어 있으면 검색을 해제하고 전체 목록으로 돌아갑니다.',
        params: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '검색어' },
            type: {
              type: 'string',
              enum: ['subject_m', 'subject', 'memo', 'name', 'comment'],
              description: '검색 대상 (기본값: subject_m)',
            },
          },
        },
        handler: async (p) => {
          const keyword = typeof p.keyword === 'string' ? p.keyword : '';
          const type = typeof p.type === 'string' ? p.type : undefined;
          if (!keyword.trim()) {
            await clearSearch();
            return { active: false, resultCount: state.posts.length };
          }
          await doSearch(keyword, type);
          return {
            active: state.searchActive,
            keyword: state.searchKeyword,
            type: state.searchType,
            resultCount: state.posts.length,
          };
        },
      }),
      clearSearch: defineCommand({
        description: '검색을 해제하고 전체 갤러리 목록으로 돌아갑니다.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await clearSearch();
          return { active: false, resultCount: state.posts.length };
        },
      }),
      saveCredentials: defineCommand({
        description: '아이디/비밀번호를 앱 스토리지(auth/credentials.json)에 저장합니다.',
        params: {
          type: 'object',
          properties: {
            username: { type: 'string', description: '저장할 아이디' },
            password: { type: 'string', description: '저장할 비밀번호 (평문)' },
          },
          required: ['username', 'password'],
        },
        handler: async (p) => {
          const creds = await saveCredentials(p.username, p.password);
          setState('savedCredentials', creds);
          return { username: creds.username, savedAt: creds.savedAt };
        },
      }),
      loadCredentials: defineCommand({
        description: '저장된 자격증명을 불러옵니다. 없으면 에러를 던집니다.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          const creds = await loadCredentials();
          if (!creds) throw new AppCommandError('저장된 자격증명 없음');
          setState('savedCredentials', creds);
          return { username: creds.username, savedAt: creds.savedAt };
        },
      }),
      submitComment: defineCommand({
        description:
          '현재 선택된 게시물에 댓글을 작성합니다. 로그인과 게시물 선택이 필요합니다. text를 주면 해당 내용으로, 없으면 현재 입력창의 내용으로 작성합니다.',
        params: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '작성할 댓글 내용' },
          },
        },
        handler: async (p) => {
          if (!state.isLoggedIn) throw new AppCommandError('로그인이 필요합니다');
          if (!state.selectedPost) throw new AppCommandError('선택된 게시물이 없습니다');
          if (typeof p.text === 'string' && p.text.trim()) {
            setState('commentText', p.text);
          }
          if (!state.commentText.trim()) throw new AppCommandError('댓글 내용이 비어 있습니다');
          await submitComment();
          if (state.commentText.trim()) {
            // submitComment clears commentText on success; a non-empty value here
            // means the post failed.
            throw new AppCommandError('댓글 작성에 실패했습니다');
          }
          return {
            ok: true,
            postNum: state.selectedPost.num,
            commentCount: state.comments.length,
          };
        },
      }),
      submitPost: defineCommand({
        description:
          '새 게시물을 작성합니다. 로그인이 필요합니다. title(제목)과 content(본문)은 필수, category(말머리: 예) 일반/정보/활용)는 선택입니다. 등록 성공 시 폼을 닫고 목록을 새로고침합니다.',
        params: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '게시물 제목' },
            content: { type: 'string', description: '게시물 본문' },
            category: { type: 'string', description: '말머리/카테고리 (선택)' },
          },
          required: ['title', 'content'],
        },
        handler: async (p) => {
          if (!state.isLoggedIn) throw new AppCommandError('로그인이 필요합니다');
          const title = typeof p.title === 'string' ? p.title.trim() : '';
          const content = typeof p.content === 'string' ? p.content.trim() : '';
          if (!title) throw new AppCommandError('제목이 비어 있습니다');
          if (!content) throw new AppCommandError('본문이 비어 있습니다');
          setState({
            writeTitle: title,
            writeContent: content,
            writeCategory: typeof p.category === 'string' && p.category.trim() ? p.category : null,
          });
          await submitPost();
          // submitPost clears writeTitle on success; a non-empty value means it failed.
          if (state.writeTitle.trim()) {
            throw new AppCommandError('게시물 작성에 실패했습니다');
          }
          return { ok: true };
        },
      }),
      setRecommendations: defineCommand({
        description:
          'AI 분석 결과를 앱에 반영합니다. topics는 현재 뜨는 주제 키워드 목록(5~8개), bestPost는 오늘의 베스트 게시물 번호와 추천 이유',
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
        handler: (p) => {
          const topics = p.topics;
          const bestPost = p.bestPost;
          setState('recLoading', false);
          setState('recommendation', {
            topics,
            bestPostNum: bestPost?.num ?? null,
            bestPostReason: bestPost?.reason ?? null,
            analyzedAt: new Date(),
          });
        },
      }),
    },
  });
}
