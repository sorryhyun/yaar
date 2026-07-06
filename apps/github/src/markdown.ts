import { marked } from '@bundled/marked';

marked.setOptions({ gfm: true, breaks: false });

/** Render GitHub markdown to HTML (synchronous). */
export function renderMarkdown(md: string | null | undefined): string {
  if (!md) return '';
  try {
    const out = marked.parse(md, { async: false }) as unknown as string;
    return typeof out === 'string' ? out : '';
  } catch {
    return escapeHtml(md);
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Decode a base64 (possibly newline-wrapped) string as UTF-8 text. */
export function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
