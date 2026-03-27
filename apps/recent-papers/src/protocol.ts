import { app, errMsg } from '@bundled/yaar';
import type { DailyPaperItem, Recommendation, PaperDetails } from './types';
import { fetchPaperDetailsById } from './data';
import { paperId, paperTitle, paperSummary, getUpvotes, getComments, getSource } from './paper-utils';

export type ProtocolDeps = {
  getPapers: () => DailyPaperItem[];
  getSourcePapers: () => DailyPaperItem[];
  getRecommendations: () => Recommendation[];
  setRecommendations: (recs: Recommendation[]) => void;
  loadPapers: () => Promise<void>;
  requestRecommendationsFromAgent: (source: 'button' | 'app-command') => void;
  paperDetailsCache: Record<string, PaperDetails>;
};

export function registerProtocol(deps: ProtocolDeps): void {
  if (!app) return;

  const {
    getPapers, getSourcePapers, getRecommendations, setRecommendations,
    loadPapers, requestRecommendationsFromAgent, paperDetailsCache,
  } = deps;

  app.register({
    appId: 'recent-papers',
    name: 'Recent Papers',
    state: {
      papers: {
        description: 'Current filtered paper list loaded in the UI',
        handler: () => getPapers().map((p) => ({
          id: paperId(p),
          source: getSource(p),
          title: paperTitle(p),
          summary: paperSummary(p),
          upvotes: getUpvotes(p),
          comments: getComments(p),
        })),
      },
      recommendations: {
        description: 'Current recommended papers',
        handler: () => getRecommendations(),
      },
      paperDetailsCache: {
        description: 'Cached detailed paper data fetched by paper id',
        handler: () => paperDetailsCache,
      },
    },
    commands: {
      refresh: {
        description: 'Reload papers from selected sources',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await loadPapers();
          return { count: getPapers().length };
        },
      },
      recommendTop2Today: {
        description: 'Ask the AI agent to recommend 2 papers from current context',
        params: { type: 'object', properties: {} },
        handler: async () => {
          if (!getSourcePapers().length) await loadPapers();
          requestRecommendationsFromAgent('app-command');
          return { queued: true, candidateCount: getPapers().length };
        },
      },
      fetchPaperDetails: {
        description: 'Fetch detailed summary/content metadata for one Hugging Face paper by id',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        handler: async (p: Record<string, unknown>) => {
          const detail = await fetchPaperDetailsById(p.id as string, paperDetailsCache);
          return { detail };
        },
      },
      fetchPaperDetailsBatch: {
        description: 'Fetch detailed summary/content metadata for multiple Hugging Face paper ids',
        params: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'string' } } },
          required: ['ids'],
        },
        handler: async (p: Record<string, unknown>) => {
          const ids = Array.isArray(p.ids) ? (p.ids as string[]).filter(Boolean).slice(0, 20) : [];
          const details: any[] = [];
          for (const id of ids) {
            try {
              details.push(await fetchPaperDetailsById(id, paperDetailsCache));
            } catch (e) {
              details.push({ id, error: errMsg(e) });
            }
          }
          return { count: details.length, details };
        },
      },
      setRecommendations: {
        description: 'Set AI-generated recommendations to display in the UI',
        params: {
          type: 'object',
          properties: {
            recommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  reason: { type: 'string' },
                  upvotes: { type: 'number' },
                  comments: { type: 'number' },
                  source: { type: 'string' },
                  url: { type: 'string' },
                },
                required: ['id', 'title', 'reason'],
              },
            },
          },
          required: ['recommendations'],
        },
        handler: async (p: Record<string, unknown>) => {
          setRecommendations(
            ((p.recommendations as Recommendation[]) || []).slice(0, 2).map((r) => ({
              id: String(r.id || ''),
              title: String(r.title || 'Untitled paper'),
              reason: String(r.reason || ''),
              upvotes: Number(r.upvotes || 0),
              comments: Number(r.comments || 0),
              source: (r.source || 'arxiv') as any,
              url: String(r.url || ''),
            })),
          );
          return { count: getRecommendations().length };
        },
      },
    },
  });
}
