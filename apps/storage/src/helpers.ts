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
