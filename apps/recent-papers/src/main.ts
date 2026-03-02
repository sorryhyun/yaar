export {};
import { signal, html, mount, show } from '@bundled/yaar';
import type { DailyPaperItem, Recommendation, PaperDetails } from './types';
import {
  getComments, getPublishedAt, getPublishedMs, getSource, getUpvotes,
  paperAbsUrl, paperId, paperSummary, paperTitle, formatDate,
} from './paper-utils';
import { fetchArxivPapers, fetchHfPapers, fetchPaperDetailsById } from './data';
import './styles.css';

// ── Signals ──────────────────────────────────────────────────────────────────
const sourcePapers = signal<DailyPaperItem[]>([]);
const papers = signal<DailyPaperItem[]>([]);
const recommendations = signal<Recommendation[]>([]);
const loading = signal(false);
const errorMsg = signal('');
const sourceMode = signal<'huggingface' | 'arxiv' | 'both'>('huggingface');
const limitVal = signal(20);
const dayRange = signal('all');
const sortBy = signal('newest');
const arxivQuery = signal('cat:cs.AI OR cat:cs.LG');
let paperDetailsCache: Record<string, PaperDetails> = {};

// ── Logic ────────────────────────────────────────────────────────────────────
function applyFiltersAndSort() {
  let result = [...sourcePapers()];
  const dr = dayRange();
  const sb = sortBy();

  if (dr !== 'all') {
    const days = Number(dr);
    if (Number.isFinite(days) && days > 0) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      result = result.filter((item) => getPublishedMs(item) >= cutoff);
    }
  }

  if (sb === 'newest') result.sort((a, b) => getPublishedMs(b) - getPublishedMs(a));
  else if (sb === 'oldest') result.sort((a, b) => getPublishedMs(a) - getPublishedMs(b));
  else if (sb === 'vote') result.sort((a, b) => {
    const dv = getUpvotes(b) - getUpvotes(a);
    if (dv !== 0) return dv;
    const dc = getComments(b) - getComments(a);
    if (dc !== 0) return dc;
    return getPublishedMs(b) - getPublishedMs(a);
  });
  else if (sb === 'comments') result.sort((a, b) => getComments(b) - getComments(a));
  else if (sb === 'title') result.sort((a, b) => paperTitle(a).localeCompare(paperTitle(b)));

  papers(result);
}

async function loadPapers() {
  if (loading()) return;
  loading(true);
  errorMsg('');
  try {
    const lim = limitVal();
    const mode = sourceMode();
    let hfItems: DailyPaperItem[] = [];
    let arxivItems: DailyPaperItem[] = [];

    if (mode === 'huggingface' || mode === 'both') {
      const hfLimit = mode === 'both' ? Math.ceil(lim / 2) : lim;
      hfItems = await fetchHfPapers(hfLimit, sortBy());
    }
    if (mode === 'arxiv' || mode === 'both') {
      const axLimit = mode === 'both' ? Math.floor(lim / 2) || 1 : lim;
      arxivItems = await fetchArxivPapers(axLimit, arxivQuery(), sortBy());
    }

    sourcePapers([...hfItems, ...arxivItems]);
    applyFiltersAndSort();
  } catch (err: any) {
    sourcePapers([]);
    papers([]);
    errorMsg(err?.message || String(err));
  } finally {
    loading(false);
  }
}

function requestRecommendationsFromAgent(source: 'button' | 'app-command') {
  const p = papers();
  const lim = limitVal();
  const payload = {
    event: 'recent-papers:recommend-2',
    source,
    date: new Date().toISOString(),
    context: {
      mode: sourceMode(),
      arxivQuery: arxivQuery(),
      limit: lim,
      dayRange: dayRange(),
      sortBy: sortBy(),
      visibleCount: p.length,
    },
    papers: p.slice(0, Math.max(1, lim)).map((item) => ({
      id: paperId(item),
      title: paperTitle(item),
      source: getSource(item),
      summary: item?.summary || item?.paper?.summary || '',
      aiSummary: item?.paper?.ai_summary || '',
      upvotes: getUpvotes(item),
      comments: getComments(item),
      publishedAt: getPublishedAt(item),
      authors: getSource(item) === 'arxiv'
        ? item?.arxiv?.authors || []
        : (item?.paper?.authors || []).map((a) => a?.name).filter(Boolean),
      links: {
        huggingFace: `https://huggingface.co/papers/${paperId(item)}`,
        arxiv: paperAbsUrl(item),
      },
    })),
  };
  (window as any).yaar?.app?.sendInteraction?.(payload);
}

// ── Components ────────────────────────────────────────────────────────────────
function PaperCard(item: DailyPaperItem) {
  const source = getSource(item);
  const id = paperId(item);
  const title = paperTitle(item);
  const summary = paperSummary(item);
  const published = getPublishedAt(item);
  const org = item?.organization?.fullname || item?.organization?.name || item?.arxiv?.primaryCategory;
  const comments = getComments(item);
  const upvotes = getUpvotes(item);
  const thumbnail = source === 'huggingface'
    ? (item?.thumbnail || 'https://huggingface.co/front/assets/huggingface_logo-noborder.svg')
    : 'https://static.arxiv.org/static/browse/0.3.4/images/arxiv-logo-one-color-white.svg';
  const absUrl = paperAbsUrl(item);

  return html`
    <article class="card">
      <div class="card-inner">
        <img class="thumb" src="${thumbnail}" alt="thumbnail" loading="lazy" />
        <div class="content">
          <h2 class="title"><a href="${absUrl}" target="_blank" rel="noreferrer">${title}</a></h2>
          <div class="meta">
            <span class="tag">${source === 'huggingface' ? 'Hugging Face' : 'arXiv'}</span>
            <span>🗓 ${formatDate(published)}</span>
            <span>👍 ${upvotes}</span>
            <span>💬 ${comments} comments</span>
            ${org ? html`<span>🏷 ${org}</span>` : ''}
          </div>
          <p class="summary">${summary}</p>
          <div class="links">
            ${source === 'huggingface' ? html`<a href="https://huggingface.co/papers/${id}" target="_blank" rel="noreferrer">Hugging Face</a>` : ''}
            <a href="${absUrl}" target="_blank" rel="noreferrer">arXiv</a>
            ${item?.arxiv?.pdfUrl ? html`<a href="${item.arxiv.pdfUrl}" target="_blank" rel="noreferrer">PDF</a>` : ''}
          </div>
        </div>
      </div>
    </article>
  `;
}

function Section(title: string, items: DailyPaperItem[]) {
  return html`
    <section style="margin-top: 12px;">
      <h3 style="margin: 0 0 10px; font-size: 15px; color: #cfd8e6;">${title} (${items.length})</h3>
      ${items.length === 0
        ? html`<div class="empty">No papers available for this source.</div>`
        : html`<div class="grid">${items.map((item) => PaperCard(item))}</div>`
      }
    </section>
  `;
}

// ── Mount ────────────────────────────────────────────────────────────────────
mount(html`
  <div class="wrap y-app">
    <div class="top">
      <h1>📚 Recent Papers</h1>
      <span class="muted">Sources: Hugging Face + arXiv</span>
      <div class="spacer"></div>

      <label class="muted">Source</label>
      <select onChange=${(e: Event) => { sourceMode((e.target as HTMLSelectElement).value as any); loadPapers(); }}>
        <option value="huggingface" selected>Hugging Face</option>
        <option value="arxiv">arXiv</option>
        <option value="both">Both</option>
      </select>

      <label class="muted">Limit</label>
      <select onChange=${(e: Event) => { limitVal(Number((e.target as HTMLSelectElement).value)); loadPapers(); }}>
        <option value="10">10</option>
        <option value="20" selected>20</option>
        <option value="40">40</option>
      </select>

      <label class="muted">Days</label>
      <select onChange=${(e: Event) => { dayRange((e.target as HTMLSelectElement).value); applyFiltersAndSort(); }}>
        <option value="all" selected>All</option>
        <option value="1">1 day</option>
        <option value="3">3 days</option>
        <option value="7">7 days</option>
        <option value="14">14 days</option>
        <option value="30">30 days</option>
      </select>

      <label class="muted">Sort</label>
      <select onChange=${(e: Event) => { sortBy((e.target as HTMLSelectElement).value); loadPapers(); }}>
        <option value="newest" selected>Newest</option>
        <option value="oldest">Oldest</option>
        <option value="vote">Most votes</option>
        <option value="comments">Most comments</option>
        <option value="title">Title (A→Z)</option>
      </select>

      <input
        placeholder="arXiv query (e.g. all:transformer OR cat:cs.AI)"
        ref=${(el: HTMLInputElement) => { el.value = arxivQuery(); }}
        onInput=${(e: Event) => arxivQuery((e.target as HTMLInputElement).value)}
        onKeyDown=${(e: KeyboardEvent) => { if (e.key === 'Enter') loadPapers(); }}
      />

      <button class="recommend-btn" onClick=${() => requestRecommendationsFromAgent('button')}>Recommend 2 papers</button>
      <button onClick=${() => loadPapers()}>Refresh</button>
    </div>

    <div class="muted">${() => {
      if (loading()) return 'Loading papers...';
      if (errorMsg()) return `Failed to load papers: ${errorMsg()}`;
      const p = papers(), sp = sourcePapers();
      const hfCount = p.filter((x) => getSource(x) === 'huggingface').length;
      const arxivCount = p.filter((x) => getSource(x) === 'arxiv').length;
      return `Showing ${p.length} of ${sp.length} papers (HF ${hfCount} • arXiv ${arxivCount}) • Last updated ${new Date().toLocaleTimeString()}`;
    }}</div>

    ${show(
      () => recommendations().length > 0,
      () => html`
        <div class="recommend-box">
          <h3 class="recommend-title">🤖 Today's 2 recommended papers</h3>
          ${() => recommendations().map((r, i) => html`
            <p class="recommend-item">
              <strong>${i + 1}.</strong>
              <a href="${r.url || `https://arxiv.org/abs/${r.id}`}" target="_blank" rel="noreferrer">${r.title}</a>
              — ${r.reason} (👍 ${r.upvotes}, 💬 ${r.comments})
            </p>
          `)}
        </div>
      `
    )}

    <div style="margin-top: 10px;">
      ${() => {
        if (loading()) return html``;
        const p = papers();
        if (p.length === 0) return html`<div class="empty">No papers available for this filter.</div>`;
        const mode = sourceMode();
        if (mode === 'both') {
          const hf = p.filter((x) => getSource(x) === 'huggingface');
          const arxiv = p.filter((x) => getSource(x) === 'arxiv');
          return html`${Section('Hugging Face Papers', hf)}${Section('arXiv Papers', arxiv)}`;
        }
        return html`<div class="grid">${p.map((item) => PaperCard(item))}</div>`;
      }}
    </div>
  </div>
`);

// ── App Protocol ──────────────────────────────────────────────────────────────
const appApi = (window as any).yaar?.app;
if (appApi) {
  appApi.register({
    appId: 'recent-papers',
    name: 'Recent Papers',
    state: {
      papers: {
        description: 'Current filtered paper list loaded in the UI',
        handler: () => papers().map((p) => ({
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
        handler: () => recommendations(),
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
        handler: async () => { await loadPapers(); return { ok: true, count: papers().length }; },
      },
      recommendTop2Today: {
        description: 'Ask the AI agent to recommend 2 papers from current context',
        params: { type: 'object', properties: {} },
        handler: async () => {
          if (!sourcePapers().length) await loadPapers();
          requestRecommendationsFromAgent('app-command');
          return { ok: true, queued: true, candidateCount: papers().length };
        },
      },
      fetchPaperDetails: {
        description: 'Fetch detailed summary/content metadata for one Hugging Face paper by id',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        handler: async (p: { id: string }) => {
          const detail = await fetchPaperDetailsById(p.id, paperDetailsCache);
          return { ok: true, detail };
        },
      },
      fetchPaperDetailsBatch: {
        description: 'Fetch detailed summary/content metadata for multiple Hugging Face paper ids',
        params: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
        handler: async (p: { ids: string[] }) => {
          const ids = Array.isArray(p.ids) ? p.ids.filter(Boolean).slice(0, 20) : [];
          const details: any[] = [];
          for (const id of ids) {
            try { details.push(await fetchPaperDetailsById(id, paperDetailsCache)); }
            catch (e: any) { details.push({ id, error: e?.message || String(e) }); }
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
                  id: { type: 'string' }, title: { type: 'string' }, reason: { type: 'string' },
                  upvotes: { type: 'number' }, comments: { type: 'number' },
                  source: { type: 'string' }, url: { type: 'string' },
                },
                required: ['id', 'title', 'reason'],
              },
            },
          },
          required: ['recommendations'],
        },
        handler: async (p: { recommendations: Recommendation[] }) => {
          recommendations(
            (p.recommendations || []).slice(0, 2).map((r) => ({
              id: String(r.id || ''),
              title: String(r.title || 'Untitled paper'),
              reason: String(r.reason || ''),
              upvotes: Number(r.upvotes || 0),
              comments: Number(r.comments || 0),
              source: (r.source || 'arxiv') as any,
              url: String(r.url || ''),
            }))
          );
          return { ok: true, count: recommendations().length };
        },
      },
    },
  });
}

loadPapers();
