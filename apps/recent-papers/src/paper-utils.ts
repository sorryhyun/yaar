import type { DailyPaperItem, PaperSource } from './types';

export function formatDate(iso?: string) {
  if (!iso) return 'Unknown date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function getSource(item: DailyPaperItem): PaperSource {
  return item.source || 'huggingface';
}

export function getPublishedAt(item: DailyPaperItem): string | undefined {
  return item?.paper?.publishedAt || item?.publishedAt;
}

export function getPublishedMs(item: DailyPaperItem): number {
  const iso = getPublishedAt(item);
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function getUpvotes(item: DailyPaperItem): number {
  const v = item?.paper?.upvotes ?? item?.upvotes ?? 0;
  return Number.isFinite(v) ? v : 0;
}

export function getComments(item: DailyPaperItem): number {
  const c = item?.numComments ?? 0;
  return Number.isFinite(c) ? c : 0;
}

export function paperId(item: DailyPaperItem): string {
  return item?.paper?.id || item?.id || 'unknown';
}

export function paperTitle(item: DailyPaperItem): string {
  return item?.paper?.title || item?.title || 'Untitled paper';
}

export function paperSummary(item: DailyPaperItem): string {
  return item?.paper?.ai_summary || item?.summary || item?.paper?.summary || 'No summary available.';
}

export function paperAbsUrl(item: DailyPaperItem): string {
  if (item?.arxiv?.absUrl) return item.arxiv.absUrl;
  const id = paperId(item);
  return `https://arxiv.org/abs/${id}`;
}

export function normalizeText(s?: string) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function parseArxivIdFromUrl(url: string): string {
  const clean = String(url || '').trim();
  if (!clean) return '';
  const m = clean.match(/\/abs\/(.+)$/);
  return m?.[1] || clean;
}

export function getFirstText(el: Element, tag: string): string {
  const node = el.getElementsByTagName(tag)[0];
  return normalizeText(node?.textContent || '');
}

export function getApiSort(sortBy: string): 'publishedAt' | 'trending' {
  return sortBy === 'vote' ? 'trending' : 'publishedAt';
}
