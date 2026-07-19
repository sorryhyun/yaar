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
import { esc, safeUrl, sanitizeMarkup } from './sanitize';

const HF_LOGO = 'https://huggingface.co/front/assets/huggingface_logo-noborder.svg';
const ARXIV_LOGO = 'https://static.arxiv.org/static/browse/0.3.4/images/arxiv-logo-one-color-white.svg';

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
  // `recommendations` arrive from the agent via the app protocol and are derived
  // from the same remote paper feeds — untrusted. Escape each field, allowlist
  // the URL protocol, then sanitize the assembled fragment before inserting.
  recommendBoxEl.innerHTML = sanitizeMarkup(`
    <h3 class="recommend-title">🤖 Today's 2 recommended papers</h3>
    ${recommendations
      .map(
        (r, i) => `
      <p class="recommend-item">
        <strong>${i + 1}.</strong>
        <a href="${safeUrl(r.url, `https://arxiv.org/abs/${encodeURIComponent(String(r.id ?? ''))}`)}" target="_blank" rel="noreferrer">${esc(r.title)}</a>
        — ${esc(r.reason)} (👍 ${esc(r.upvotes)}, 💬 ${esc(r.comments)})
      </p>
    `,
      )
      .join('')}
  `);
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
  const thumbnail = source === 'huggingface' ? safeUrl(item?.thumbnail, HF_LOGO) : esc(ARXIV_LOGO);
  const absUrl = safeUrl(paperAbsUrl(item));
  const pdfUrl = safeUrl(item?.arxiv?.pdfUrl);
  const hfUrl = safeUrl(`https://huggingface.co/papers/${encodeURIComponent(id)}`);

  // Every value below is remote-sourced text; none of it may reach an HTML or
  // attribute context unescaped. URLs additionally pass a http(s) allowlist.
  return `
    <article class="card">
      <div class="card-inner">
        <img class="thumb" src="${thumbnail}" alt="thumbnail for ${esc(title)}" loading="lazy" />
        <div class="content">
          <h2 class="title"><a href="${absUrl}" target="_blank" rel="noreferrer">${esc(title)}</a></h2>
          <div class="meta">
            <span class="tag">${source === 'huggingface' ? 'Hugging Face' : 'arXiv'}</span>
            <span>🗓 ${esc(formatDate(published))}</span>
            <span>👍 ${esc(upvotes)}</span>
            <span>💬 ${esc(comments)} comments</span>
            ${org ? `<span>🏷 ${esc(org)}</span>` : ''}
          </div>
          <p class="summary">${esc(summary)}</p>
          <div class="links">
            ${source === 'huggingface' && hfUrl ? `<a href="${hfUrl}" target="_blank" rel="noreferrer">Hugging Face</a>` : ''}
            ${absUrl ? `<a href="${absUrl}" target="_blank" rel="noreferrer">arXiv</a>` : ''}
            ${pdfUrl ? `<a href="${pdfUrl}" target="_blank" rel="noreferrer">PDF</a>` : ''}
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
        <div class="y-empty empty">No papers available for this source.</div>
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
    listEl.innerHTML = '<div class="y-empty empty">No papers available for this filter.</div>';
    return;
  }

  if (sourceMode === 'both') {
    const hf = papers.filter((p) => getSource(p) === 'huggingface');
    const arxiv = papers.filter((p) => getSource(p) === 'arxiv');
    listEl.innerHTML = sanitizeMarkup(
      `${renderSection('Hugging Face Papers', hf)}${renderSection('arXiv Papers', arxiv)}`,
    );
    return;
  }

  listEl.innerHTML = sanitizeMarkup(
    `<div class="grid">${papers.map((item) => renderPaperCard(item)).join('')}</div>`,
  );
}
