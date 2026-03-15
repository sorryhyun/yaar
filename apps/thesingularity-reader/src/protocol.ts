import { app } from '@bundled/yaar';
import { setRecommendation, setRecLoading } from './store';

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'thesingularity-reader',
    name: '특이점이 온다',
    state: {},
    commands: {
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
        handler: (p: { topics: string[]; bestPost?: { num: string; reason: string } }) => {
          setRecLoading(false);
          setRecommendation({
            topics: p.topics,
            bestPostNum: p.bestPost?.num ?? null,
            bestPostReason: p.bestPost?.reason ?? null,
            analyzedAt: new Date(),
          });
          return { ok: true };
        },
      },
    },
  });
}
