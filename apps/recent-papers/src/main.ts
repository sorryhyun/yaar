export {};
import { createSignal, createEffect, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { app, errMsg, withLoading } from '@bundled/yaar';
import type { DailyPaperItem, Recommendation } from './types';
import {
  getComments, getPublishedAt, getPublishedMs, getSource, getUpvotes,
  paperAbsUrl, paperId, paperSummary, paperTitle, formatDate,
} from './paper-utils';
import { fetchArxivPapers, fetchHfPapers } from './data';
import { registerProtocol } from './protocol';
import { renderActivityChart, destroyChart } from './chart';
import './styles.css';

// ── Signals ───────────────────────────────────────────────────────────────────────
const [sourcePapers, setSourcePapers] = createSignal<DailyPaperItem[]>([]);
const [papers, setPapers] = createSignal<DailyPaperItem[]>([]);
const [recommendations, setRecommendations] = createSignal<Recommendation[]>([]);
const [loading, setLoading] = createSignal(false);
const [errorMsg, setErrorMsg] = createSignal('');
const [sourceMode, setSourceMode] = createSignal<'huggingface' | 'arxiv' | 'both'>('huggingface');
const [limitVal, setLimitVal] = createSignal(20);
const [dayRange, setDayRange] = createSignal('all');
const [sortBy, setSortBy] = createSignal('newest');
const [arxivQuery, setArxivQuery] = createSignal('cat:cs.AI OR cat:cs.LG');
const [chartOpen, setChartOpen] = createSignal(false);
let chartCanvasRef: HTMLCanvasElement | undefined;
const paperDetailsCache: Record<string, import('./types').PaperDetails> = {};

// ── Logic ──────────────────────────────────────────────────────────────────────────
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

  setPapers(result);
}

async function loadPapers() {
  if (loading()) return;
  setErrorMsg('');
  await withLoading(setLoading, async () => {
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

    setSourcePapers([...hfItems, ...arxivItems]);
    applyFiltersAndSort();
  }, (msg) => {
    setSourcePapers([]);
    setPapers([]);
    setErrorMsg(msg);
  });
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
  app?.sendInteraction?.(payload);
}

// ── Chart Effect ────────────────────────────────────────────────────────────────────────
createEffect(() => {
  if (!chartOpen()) return;
  papers(); // track papers changes
  // Wait one tick for canvas to be mounted
  setTimeout(() => {
    if (chartCanvasRef) renderActivityChart(chartCanvasRef, papers());
  }, 0);
});

// ── Components ─────────────────────────────────────────────────────────────────────────
function PaperCard(props: { item: DailyPaperItem }) {
  const item = props.item;
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

function Section(props: { title: string; items: DailyPaperItem[] }) {
  return html`
    <section style="margin-top: 12px;">
      <h3 style="margin: 0 0 10px; font-size: 15px; color: #cfd8e6;">${props.title} (${props.items.length})</h3>
      ${props.items.length === 0
        ? html`<div class="y-empty empty">No papers available for this source.</div>`
        : html`<div class="grid"><${For} each=${props.items}>${(item: DailyPaperItem) => html`<${PaperCard} item=${item} />`}</${For}></div>`
      }
    </section>
  `;
}

// ── Mount ────────────────────────────────────────────────────────────────────────────
render(() => html`
  <div class="wrap y-app">
    <div class="top">
      <h1>📚 Recent Papers</h1>
      <span class="muted">Sources: Hugging Face + arXiv</span>
      <div class="spacer"></div>

      <label class="muted">Source</label>
      <select onChange=${(e: Event) => { setSourceMode((e.target as HTMLSelectElement).value as any); loadPapers(); }}>
        <option value="huggingface" selected>Hugging Face</option>
        <option value="arxiv">arXiv</option>
        <option value="both">Both</option>
      </select>

      <label class="muted">Limit</label>
      <select onChange=${(e: Event) => { setLimitVal(Number((e.target as HTMLSelectElement).value)); loadPapers(); }}>
        <option value="10">10</option>
        <option value="20" selected>20</option>
        <option value="40">40</option>
      </select>

      <label class="muted">Days</label>
      <select onChange=${(e: Event) => { setDayRange((e.target as HTMLSelectElement).value); applyFiltersAndSort(); }}>
        <option value="all" selected>All</option>
        <option value="1">1 day</option>
        <option value="3">3 days</option>
        <option value="7">7 days</option>
        <option value="14">14 days</option>
        <option value="30">30 days</option>
      </select>

      <label class="muted">Sort</label>
      <select onChange=${(e: Event) => { setSortBy((e.target as HTMLSelectElement).value); loadPapers(); }}>
        <option value="newest" selected>Newest</option>
        <option value="oldest">Oldest</option>
        <option value="vote">Most votes</option>
        <option value="comments">Most comments</option>
        <option value="title">Title (A→Z)</option>
      </select>

      <input
        placeholder="arXiv query (e.g. all:transformer OR cat:cs.AI)"
        value=${arxivQuery()}
        onInput=${(e: Event) => setArxivQuery((e.target as HTMLInputElement).value)}
        onKeyDown=${(e: KeyboardEvent) => { if (e.key === 'Enter') loadPapers(); }}
      />

      <button class="recommend-btn" onClick=${() => requestRecommendationsFromAgent('button')}>Recommend 2 papers</button>
      <button class="chart-btn" onClick=${() => {
        const newOpen = !chartOpen();
        setChartOpen(newOpen);
        if (!newOpen) destroyChart();
      }}>📊 ${() => chartOpen() ? 'Hide Chart' : 'Activity Chart'}</button>
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

    ${() => chartOpen() ? html`
      <div class="chart-panel">
        <div class="chart-head">
          <span>📊 Publication Activity</span>
          <span class="muted">${() => papers().length} papers</span>
        </div>
        <div class="chart-wrap">
          <canvas ref=${(el: HTMLCanvasElement) => { chartCanvasRef = el; }} height="160"></canvas>
        </div>
      </div>
    ` : ''}

    ${() => recommendations().length > 0 ? html`
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
    ` : ''}

    <div style="margin-top: 10px;">
      ${() => {
        if (loading()) return null;
        const p = papers();
        if (p.length === 0) return html`<div class="y-empty empty">No papers available for this filter.</div>`;
        const mode = sourceMode();
        if (mode === 'both') {
          const hf = p.filter((x) => getSource(x) === 'huggingface');
          const arxiv = p.filter((x) => getSource(x) === 'arxiv');
          return html`
            <${Section} title="Hugging Face Papers" items=${hf} />
            <${Section} title="arXiv Papers" items=${arxiv} />
          `;
        }
        return html`<div class="grid"><${For} each=${p}>${(item: DailyPaperItem) => html`<${PaperCard} item=${item} />`}</${For}></div>`;
      }}
    </div>
  </div>
`, document.getElementById('app')!);

// ── App Protocol ──────────────────────────────────────────────────────────────────────────
registerProtocol({
  getPapers: () => papers(),
  getSourcePapers: () => sourcePapers(),
  getRecommendations: () => recommendations(),
  setRecommendations: (recs) => setRecommendations(recs),
  loadPapers,
  requestRecommendationsFromAgent,
  paperDetailsCache,
});

loadPapers();
