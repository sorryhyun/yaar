import type { DailyPaperItem, Recommendation } from './types';
import {
  formatDate,
  getComments,
  getSource,
  getUpvotes,
  paperAbsUrl,
  paperId,
  paperSummary,
  paperTitle,
  getPublishedAt,
} from './paper-utils';

type RenderArgs = {
  statusEl: HTMLDivElement;
  listEl: HTMLDivElement;
  recommendBoxEl: HTMLDivElement;
  papers: DailyPaperItem[];
  sourcePapers: DailyPaperItem[];
  recommendations: Recommendation[];
  loading: boolean;
  sourceMode: string;
};

export function renderRecommendations(recommendBoxEl: HTMLDivElement, recommendations: Recommendation[]) {
  if (!recommendations.length) {
    recommendBoxEl.style.display = 'none';
    recommendBoxEl.innerHTML = '';
    return;
  }

  recommendBoxEl.style.display = 'block';
  recommendBoxEl.innerHTML = `
    <h3 class="recommend-title">🤖 Today's 2 recommended papers</h3>
    ${recommendations
      .map(
        (r, i) => `
      <p class="recommend-item">
        <strong>${i + 1}.</strong>
        <a href="${r.url || `https://arxiv.org/abs/${r.id}`}" target="_blank" rel="noreferrer">${r.title}</a>
        — ${r.reason} (👍 ${r.upvotes}, 💬 ${r.comments})
      </p>
    `,
      )
      .join('')}
  `;
}

function renderPaperCard(item: DailyPaperItem): string {
  const source = getSource(item);
  const id = paperId(item);
  const title = paperTitle(item);
  const summary = paperSummary(item);
  const published = getPublishedAt(item);
  const org = item?.organization?.fullname || item?.organization?.name || item?.arxiv?.primaryCategory;
  const comments = getComments(item);
  const upvotes = getUpvotes(item);
  const thumbnail =
    source === 'huggingface'
      ? item?.thumbnail || 'https://huggingface.co/front/assets/huggingface_logo-noborder.svg'
      : 'https://static.arxiv.org/static/browse/0.3.4/images/arxiv-logo-one-color-white.svg';

  return `
    <article class="card">
      <div class="card-inner">
        <img class="thumb" src="${thumbnail}" alt="thumbnail for ${title.replace(/"/g, '&quot;')}" loading="lazy" />
        <div class="content">
          <h2 class="title"><a href="${paperAbsUrl(item)}" target="_blank" rel="noreferrer">${title}</a></h2>
          <div class="meta">
            <span class="tag">${source === 'huggingface' ? 'Hugging Face' : 'arXiv'}</span>
            <span>🗓 ${formatDate(published)}</span>
            <span>👍 ${upvotes}</span>
            <span>💬 ${comments} comments</span>
            ${org ? `<span>🏷 ${org}</span>` : ''}
          </div>
          <p class="summary">${summary}</p>
          <div class="links">
            ${source === 'huggingface' ? `<a href="https://huggingface.co/papers/${id}" target="_blank" rel="noreferrer">Hugging Face</a>` : ''}
            <a href="${paperAbsUrl(item)}" target="_blank" rel="noreferrer">arXiv</a>
            ${item?.arxiv?.pdfUrl ? `<a href="${item.arxiv.pdfUrl}" target="_blank" rel="noreferrer">PDF</a>` : ''}
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderSection(title: string, items: DailyPaperItem[]) {
  if (!items.length) {
    return `
      <section style="margin-top: 12px;">
        <h3 style="margin: 0 0 10px; font-size: 15px; color: #cfd8e6;">${title} (0)</h3>
        <div class="empty">No papers available for this source.</div>
      </section>
    `;
  }

  return `
    <section style="margin-top: 12px;">
      <h3 style="margin: 0 0 10px; font-size: 15px; color: #cfd8e6;">${title} (${items.length})</h3>
      <div class="grid">${items.map((item) => renderPaperCard(item)).join('')}</div>
    </section>
  `;
}

export function renderApp({
  statusEl,
  listEl,
  recommendBoxEl,
  papers,
  sourcePapers,
  recommendations,
  loading,
  sourceMode,
}: RenderArgs) {
  const hfCount = papers.filter((p) => getSource(p) === 'huggingface').length;
  const arxivCount = papers.filter((p) => getSource(p) === 'arxiv').length;

  statusEl.textContent = loading
    ? 'Loading papers...'
    : `Showing ${papers.length} of ${sourcePapers.length} papers (HF ${hfCount} • arXiv ${arxivCount}) • Last updated ${new Date().toLocaleTimeString()}`;

  renderRecommendations(recommendBoxEl, recommendations);

  if (!papers.length) {
    listEl.innerHTML = '<div class="empty">No papers available for this filter.</div>';
    return;
  }

  if (sourceMode === 'both') {
    const hf = papers.filter((p) => getSource(p) === 'huggingface');
    const arxiv = papers.filter((p) => getSource(p) === 'arxiv');
    listEl.innerHTML = `${renderSection('Hugging Face Papers', hf)}${renderSection('arXiv Papers', arxiv)}`;
    return;
  }

  listEl.innerHTML = `<div class="grid">${papers.map((item) => renderPaperCard(item)).join('')}</div>`;
}
