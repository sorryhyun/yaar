import type { SessionSummary } from './types';

/** YYYY-MM-DD HH:MM in local time */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${yy}-${mm}-${dd} ${hh}:${min}`;
  } catch { return '-'; }
}

/** Full datetime with seconds for detail view */
export function formatFull(iso: string | undefined): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const sec = String(d.getSeconds()).padStart(2, '0');
    return `${yy}-${mm}-${dd} ${hh}:${min}:${sec}`;
  } catch { return '-'; }
}

/** Human-readable duration between two ISO timestamps */
export function durationBetween(a: string | undefined, b: string | undefined): string {
  if (!a || !b) return '-';
  try {
    const ms = new Date(b).getTime() - new Date(a).getTime();
    if (isNaN(ms) || ms < 0) return '0s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const mn = Math.floor(s / 60);
    if (mn < 60) return `${mn}m ${s % 60}s`;
    const h = Math.floor(mn / 60);
    return `${h}h ${mn % 60}m`;
  } catch { return '-'; }
}

/** YYYY-MM-DD date key from createdAt (with sessionId fallback) */
export function getDateKey(s: SessionSummary): string {
  if (s.createdAt) {
    try {
      const d = new Date(s.createdAt);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    } catch { /* fall through */ }
  }
  const match = s.sessionId.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : 'unknown';
}

/** Friendly date group label */
export function formatDateLabel(dateStr: string): string {
  if (dateStr === 'unknown') return 'Unknown Date';
  const [y, m, d] = dateStr.split('-').map(Number);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const yesterdayStr = `${yest.getFullYear()}-${pad(yest.getMonth() + 1)}-${pad(yest.getDate())}`;
  if (dateStr === todayStr) return `Today  ${y}.${pad(m)}.${pad(d)}`;
  if (dateStr === yesterdayStr) return `Yesterday  ${y}.${pad(m)}.${pad(d)}`;
  return `${y}.${pad(m)}.${pad(d)}`;
}

/** Canonical display label for provider */
export function providerLabel(p: string | undefined): string {
  if (!p) return 'unknown';
  return p.trim() || 'unknown';
}

/** CSS class string for provider badge */
export function providerCls(p: string | undefined): string {
  const slug = providerLabel(p).toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `provider-badge provider-${slug}`;
}
