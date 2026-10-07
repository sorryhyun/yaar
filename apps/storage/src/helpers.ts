export {};
import { formatBytes } from '@bundled/yaar';

export function basename(path: string): string {
  const parts = path.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || path;
}

export function sanitizeAlias(alias: string): string {
  return alias
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** `formatBytes`, but blank for a missing `size` (a directory) instead of `'0 B'`. */
export function formatSize(bytes?: number): string {
  return bytes == null ? '' : formatBytes(bytes);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Milliseconds since the epoch, or null for a missing or unparseable timestamp. */
export function parseTime(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * A compact "last modified" label for a listing column: relative within the last week
 * ("just now", "5 min ago", "3 h ago", "2 d ago"), a short date after that ("Mar 4"),
 * with the year only when it is not this one. Dates use the user's locale.
 */
export function formatModified(iso: string | undefined, now: number): string {
  const t = parseTime(iso);
  if (t === null) return '';
  const age = now - t;
  // A small negative age is clock skew between server and browser, not the future.
  if (age > -MINUTE && age < MINUTE) return 'just now';
  if (age > 0 && age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age > 0 && age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age > 0 && age < 7 * DAY) return `${Math.floor(age / DAY)} d ago`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (!sameYear) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

/** The full local date and time, for a tooltip or the preview footer. */
export function formatTimestamp(iso?: string): string {
  const t = parseTime(iso);
  return t === null ? '' : new Date(t).toLocaleString();
}

export function getExtension(name: string): string {
  return name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : '';
}

export function getFileIcon(name: string, isDir: boolean): string {
  if (isDir) return '📁';
  const ext = getExtension(name);
  const icons: Record<string, string> = {
    pdf: '📄',
    txt: '📝',
    md: '📝',
    json: '{}',
    csv: '📊',
    html: '🌐',
    xml: '🌐',
    png: '🖼️',
    jpg: '🖼️',
    jpeg: '🖼️',
    gif: '🖼️',
    svg: '🖼️',
    webp: '🖼️',
    mp3: '🎵',
    wav: '🎵',
    mp4: '🎥',
    webm: '🎥',
    zip: '📦',
    tar: '📦',
    gz: '📦',
    js: '🟨',
    ts: '🔵',
    py: '🐍',
  };
  return icons[ext] || '📄';
}

export function isPreviewable(name: string): boolean {
  const ext = getExtension(name);
  return [
    'txt',
    'md',
    'json',
    'csv',
    'html',
    'xml',
    'js',
    'ts',
    'py',
    'css',
    'yaml',
    'yml',
    'toml',
    'log',
    'sh',
    'bat',
    'env',
  ].includes(ext);
}

export function isImage(name: string): boolean {
  const ext = getExtension(name);
  return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext);
}

export function isMarkdown(name: string): boolean {
  return ['md', 'mdx', 'markdown'].includes(getExtension(name));
}

export function isPdf(name: string): boolean {
  return getExtension(name) === 'pdf';
}
