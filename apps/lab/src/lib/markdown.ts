import { marked } from '@bundled/marked';
import { sanitizeHtml, errMsg } from '@bundled/yaar';

/**
 * Markdown -> HTML for markdown cells and `md()` output parts. Cell sources are
 * user-authored but the same path renders text that came back from the kernel,
 * so everything goes through sanitizeHtml before it reaches innerHTML.
 */
export function renderMarkdown(src: string): string {
  try {
    return sanitizeHtml(marked.parse(src || '') as string);
  } catch (e) {
    return sanitizeHtml('<p>markdown failed: ' + errMsg(e) + '</p>');
  }
}
