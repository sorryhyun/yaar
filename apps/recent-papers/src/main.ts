import { APP_HTML } from './template';
import type { DailyPaperItem, Recommendation, PaperDetails } from './types';
import {
  getComments,
  getPublishedAt,
  getPublishedMs,
  getSource,
  getUpvotes,
  paperAbsUrl,
  paperId,
  paperSummary,
  paperTitle,
} from './paper-utils';
import { fetchArxivPapers, fetchHfPapers, fetchPaperDetailsById } from './data';
import { renderApp } from './render';

const app = document.createElement('div');
app.innerHTML = APP_HTML;
document.body.appendChild(app);

const statusEl = document.getElementById('status') as HTMLDivElement;
const listEl = document.getElementById('list') as HTMLDivElement;
const sourceModeEl = document.getElementById('sourceMode') as HTMLSelectElement;
const limitEl = document.getElementById('limit') as HTMLSelectElement;
const dayRangeEl = document.getElementById('dayRange') as HTMLSelectElement;
const sortByEl = document.getElementById('sortBy') as HTMLSelectElement;
const arxivQueryEl = document.getElementById('arxivQuery') as HTMLInputElement;
const recommendBoxEl = document.getElementById('recommendations') as HTMLDivElement;
const recommendBtn = document.getElementById('recommend2') as HTMLButtonElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;

let sourcePapers: DailyPaperItem[] = [];
let papers: DailyPaperItem[] = [];
let recommendations: Recommendation[] = [];
let paperDetailsCache: Record<string, PaperDetails> = {};
let loading = false;

function applyFiltersAndSort() {
  const dayRange = dayRangeEl.value;
  const sortBy = sortByEl.value;

  let result = [...sourcePapers];

  if (dayRange !== 'all') {
    const days = Number(dayRange);
    if (Number.isFinite(days) && days > 0) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      result = result.filter((item) => getPublishedMs(item) >= cutoff);
    }
  }

  if (sortBy === 'newest') {
    result.sort((a, b) => getPublishedMs(b) - getPublishedMs(a));
  } else if (sortBy === 'oldest') {
    result.sort((a, b) => getPublishedMs(a) - getPublishedMs(b));
  } else if (sortBy === 'vote') {
    result.sort((a, b) => {
      const dv = getUpvotes(b) - getUpvotes(a);
      if (dv !== 0) return dv;
      const dc = getComments(b) - getComments(a);
      if (dc !== 0) return dc;
      return getPublishedMs(b) - getPublishedMs(a);
    });
  } else if (sortBy === 'comments') {
    result.sort((a, b) => getComments(b) - getComments(a));
  } else if (sortBy === 'title') {
    result.sort((a, b) => paperTitle(a).localeCompare(paperTitle(b)));
  }

  papers = result;
}

function render() {
  renderApp({
    statusEl,
    listEl,
    recommendBoxEl,
    papers,
    sourcePapers,
    recommendations,
    loading,
    sourceMode: sourceModeEl.value,
  });
}

async function loadPapers() {
  if (loading) return;
  loading = true;
  render();
  try {
    const limit = Number(limitEl.value || 20);
    const mode = sourceModeEl.value as 'huggingface' | 'arxiv' | 'both';

    let hfItems: DailyPaperItem[] = [];
    let arxivItems: DailyPaperItem[] = [];

    if (mode === 'huggingface' || mode === 'both') {
      const hfLimit = mode === 'both' ? Math.ceil(limit / 2) : limit;
      hfItems = await fetchHfPapers(hfLimit, sortByEl.value);
    }

    if (mode === 'arxiv' || mode === 'both') {
      const axLimit = mode === 'both' ? Math.floor(limit / 2) || 1 : limit;
      arxivItems = await fetchArxivPapers(axLimit, arxivQueryEl.value, sortByEl.value);
    }

    sourcePapers = [...hfItems, ...arxivItems];
    applyFiltersAndSort();
  } catch (err: any) {
    sourcePapers = [];
    papers = [];
    statusEl.textContent = `Failed to load papers: ${err?.message || String(err)}`;
  } finally {
    loading = false;
    render();
  }
}

function onFilterOrSortChanged() {
  applyFiltersAndSort();
  render();
}

function requestRecommendationsFromAgent(source: 'button' | 'app-command') {
  const payload = {
    event: 'recent-papers:recommend-2',
    source,
    date: new Date().toISOString(),
    context: {
      mode: sourceModeEl.value,
      arxivQuery: arxivQueryEl.value,
      limit: Number(limitEl.value || 20),
      dayRange: dayRangeEl.value,
      sortBy: sortByEl.value,
      visibleCount: papers.length,
    },
    papers: papers.slice(0, Math.max(1, Number(limitEl.value || 20))).map((p) => ({
      id: paperId(p),
      title: paperTitle(p),
      source: getSource(p),
      summary: p?.summary || p?.paper?.summary || '',
      aiSummary: p?.paper?.ai_summary || '',
      upvotes: getUpvotes(p),
      comments: getComments(p),
      publishedAt: getPublishedAt(p),
      authors: getSource(p) === 'arxiv' ? p?.arxiv?.authors || [] : (p?.paper?.authors || []).map((a) => a?.name).filter(Boolean),
      links: {
        huggingFace: `https://huggingface.co/papers/${paperId(p)}`,
        arxiv: paperAbsUrl(p),
      },
    })),
  };

  (window as any).yaar?.app?.sendInteraction?.(payload);
}

refreshBtn.addEventListener('click', () => loadPapers());
sourceModeEl.addEventListener('change', () => loadPapers());
limitEl.addEventListener('change', () => loadPapers());
dayRangeEl.addEventListener('change', () => onFilterOrSortChanged());
sortByEl.addEventListener('change', async () => loadPapers());
arxivQueryEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadPapers();
});
recommendBtn.addEventListener('click', () => requestRecommendationsFromAgent('button'));

loadPapers();

const appApi = (window as any).yaar?.app;
if (appApi) {
  appApi.register({
    appId: 'recent-papers',
    name: 'Recent Papers',
    state: {
      papers: {
        description: 'Current filtered paper list loaded in the UI',
        handler: () => papers.map((p) => ({
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
        handler: () => recommendations,
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
          return { ok: true, count: papers.length };
        },
      },
      recommendTop2Today: {
        description: 'Ask the AI agent to recommend 2 papers from current context',
        params: { type: 'object', properties: {} },
        handler: async () => {
          if (!sourcePapers.length) await loadPapers();
          requestRecommendationsFromAgent('app-command');
          return { ok: true, queued: true, candidateCount: papers.length };
        },
      },
      fetchPaperDetails: {
        description: 'Fetch detailed summary/content metadata for one Hugging Face paper by id',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        handler: async (p: { id: string }) => {
          const detail = await fetchPaperDetailsById(p.id, paperDetailsCache);
          return { ok: true, detail };
        },
      },
      fetchPaperDetailsBatch: {
        description: 'Fetch detailed summary/content metadata for multiple Hugging Face paper ids',
        params: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'string' } } },
          required: ['ids'],
        },
        handler: async (p: { ids: string[] }) => {
          const ids = Array.isArray(p.ids) ? p.ids.filter(Boolean).slice(0, 20) : [];
          const details = [] as any[];
          for (const id of ids) {
            try {
              details.push(await fetchPaperDetailsById(id, paperDetailsCache));
            } catch (e: any) {
              details.push({ id, error: e?.message || String(e) });
            }
          }
          return { ok: true, count: details.length, details };
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
        handler: async (p: { recommendations: Recommendation[] }) => {
          recommendations = (p.recommendations || []).slice(0, 2).map((r) => ({
            id: String(r.id || ''),
            title: String(r.title || 'Untitled paper'),
            reason: String(r.reason || ''),
            upvotes: Number(r.upvotes || 0),
            comments: Number(r.comments || 0),
            source: (r.source || 'arxiv') as any,
            url: String(r.url || ''),
          }));
          render();
          return { ok: true, count: recommendations.length };
        },
      },
    },
  });
}
