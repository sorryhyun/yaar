export {};
import type { StorageEntry } from './types';
import { storageUrl } from './storage-api';

// ── Pure utilities ──────────────────────────────────────────────

export function basename(path: string): string {
  const parts = path.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || path;
}

export function sanitizeAlias(alias: string): string {
  return alias.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getFileIcon(name: string, isDir: boolean): string {
  if (isDir) return '\uD83D\uDCC1';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, string> = {
    pdf: '\uD83D\uDCC4', txt: '\uD83D\uDCDD', md: '\uD83D\uDCDD',
    json: '{}', csv: '\uD83D\uDCCA', html: '\uD83C\uDF10', xml: '\uD83C\uDF10',
    png: '\uD83D\uDDBC\uFE0F', jpg: '\uD83D\uDDBC\uFE0F', jpeg: '\uD83D\uDDBC\uFE0F',
    gif: '\uD83D\uDDBC\uFE0F', svg: '\uD83D\uDDBC\uFE0F', webp: '\uD83D\uDDBC\uFE0F',
    mp3: '\uD83C\uDFB5', wav: '\uD83C\uDFB5', mp4: '\uD83C\uDFA5', webm: '\uD83C\uDFA5',
    zip: '\uD83D\uDCE6', tar: '\uD83D\uDCE6', gz: '\uD83D\uDCE6',
    js: '\uD83D\uDFE8', ts: '\uD83D\uDD35', py: '\uD83D\uDC0D',
  };
  return icons[ext] || '\uD83D\uDCC4';
}

export function isPreviewable(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ['txt', 'md', 'json', 'csv', 'html', 'xml', 'js', 'ts', 'py', 'css', 'yaml', 'yml', 'toml', 'log', 'sh', 'bat', 'env'].includes(ext);
}

export function isImage(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext);
}

export function getExtension(name: string): string {
  return name.includes('.') ? (name.split('.').pop()?.toLowerCase() || '') : '';
}

export function toStorageUri(path: string): string {
  const cleaned = path.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `yaar://storage/${cleaned}`;
}

export function buildDragMetadata(entry: StorageEntry) {
  const name = basename(entry.path);
  const url = !entry.isDirectory ? storageUrl(entry.path) : null;
  return {
    source: 'storage',
    appId: 'storage',
    path: entry.path,
    name,
    isDirectory: entry.isDirectory,
    size: entry.size ?? null,
    extension: entry.isDirectory ? '' : getExtension(name),
    mimeType: null,
    url,
    storageUri: toStorageUri(entry.path),
  };
}

export function isMarkdown(name: string): boolean {
  return ['md', 'mdx', 'markdown'].includes(name.split('.').pop()?.toLowerCase() || '');
}
