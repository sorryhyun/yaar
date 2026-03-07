/**
 * Shared browser tool helpers — session resolution and page state formatting.
 */

import { getBrowserPool } from '../../lib/browser/index.js';
import type { BrowserSession, PageState } from '../../lib/browser/index.js';

/**
 * Resolve a browser session by browserId.
 * If browserId is given, look up that specific browser.
 * If not given, use the only browser (or error if 0 or multiple).
 */
export function resolveSession(browserId?: string): BrowserSession {
  const pool = getBrowserPool();
  if (browserId !== undefined) {
    const session = pool.getSession(browserId);
    if (!session) throw new Error(`No browser with ID ${browserId}. Use browser:open first.`);
    return session;
  }
  const browsers = pool.getAllSessions();
  if (browsers.size === 0) throw new Error('No browser open. Use browser:open first.');
  if (browsers.size === 1) return browsers.values().next().value!;
  const ids = [...browsers.keys()].join(', ');
  throw new Error(`Multiple browsers open (${ids}). Specify browserId.`);
}

export function formatPageState(state: PageState): string {
  let result = `URL: ${state.url}`;
  if (state.urlChanged) result += ' (changed)';
  result += `\nTitle: ${state.title}`;
  if (state.activeElement) {
    const ae = state.activeElement;
    let desc = `<${ae.tag}`;
    if (ae.name) desc += ` name="${ae.name}"`;
    if (ae.id) desc += ` id="${ae.id}"`;
    if (ae.type) desc += ` type="${ae.type}"`;
    desc += '>';
    result += `\nActive element: ${desc}`;
  }
  if (state.scrollHeight && state.viewportHeight && state.scrollHeight > state.viewportHeight) {
    const percent = Math.round(
      ((state.scrollY ?? 0) / (state.scrollHeight - state.viewportHeight)) * 100,
    );
    result += `\nScroll: ${state.scrollY ?? 0}/${state.scrollHeight} (${percent}% scrolled)`;
  }
  if (state.clickTarget) {
    const ct = state.clickTarget;
    result += `\nClicked: <${ct.tag}> "${ct.text}"`;
    if (ct.candidateCount > 1) result += ` (${ct.candidateCount} candidates)`;
  }
  if (state.textSnippet) {
    result += `\n\nPage content:\n${state.textSnippet}`;
  }
  return result;
}

/** Heuristic: find the CSS selector for the largest text-containing block element. */
export async function findMainContent(session: BrowserSession): Promise<string | undefined> {
  return session.findMainContentSelector();
}
