import { state, setState } from './store';
import { app } from '@bundled/yaar';
import { saveCredentials, loadCredentials } from './credentials';

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
          return { ok: true, username: creds.username, savedAt: creds.savedAt };
        },
      },
      loadCredentials: {
        description: '저장된 자격증명을 불러옵니다. 없으면 ok: false 반환.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          const creds = await loadCredentials();
          if (creds) setState('savedCredentials', creds);
          return creds
            ? { ok: true, username: creds.username, savedAt: creds.savedAt }
            : { ok: false, message: '저장된 자격증명 없음' };
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
          return { ok: true };
        },
      },
    },
  });
}
