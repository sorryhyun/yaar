import type { AppState, Feed } from './types';
import { FALLBACK_FEEDS, feeds, setFeeds, readArticleIds, setReadArticleIds } from './store';
import { extractDomainName } from './utils';
import { storage } from '@bundled/yaar';

const STATE_PATH = 'feeds.json';
const FEED_SOURCE_PATHS = ['feeds.txt', 'feed-sources.txt'];

function hashToId(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    hash = hash >>> 0;
  }
  return `src_${hash.toString(36)}`;
}

function parseFeedSourcesText(text: string): Feed[] {
  const result: Feed[] = [];
  const seenUrls = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let name = '', url = '';
    const pipeIdx = line.indexOf('|');
    if (pipeIdx > 0) { name = line.slice(0, pipeIdx).trim(); url = line.slice(pipeIdx + 1).trim(); }
    else {
      const commaIdx = line.indexOf(',');
      if (commaIdx > 0 && /^https?:\/\//i.test(line.slice(commaIdx + 1).trim())) {
        name = line.slice(0, commaIdx).trim(); url = line.slice(commaIdx + 1).trim();
      } else { url = line; }
    }
    try {
      const normalized = new URL(url).toString();
      if (seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);
      result.push({ id: hashToId(normalized), name: name || extractDomainName(normalized), url: normalized });
    } catch { /* ignore */ }
  }
  return result;
}

async function loadFeedsFromSourceFile(): Promise<Feed[] | null> {
  if (!storage) return null;
  for (const path of FEED_SOURCE_PATHS) {
    try {
      const text = await storage.read(path, { as: 'text' }) as unknown as string;
      const parsed = parseFeedSourcesText(String(text || ''));
      if (parsed.length > 0) return parsed;
    } catch { /* missing file ok */ }
  }
  return null;
}

export async function loadState(): Promise<void> {
  let saved: AppState | null = null;
  if (storage) {
    try {
      const data = await storage.read(STATE_PATH, { as: 'json' });
      if (data && typeof data === 'object') saved = data as AppState;
    } catch { /* use defaults */ }
  }

  const sourceFeeds = await loadFeedsFromSourceFile();
  if (sourceFeeds && sourceFeeds.length > 0) setFeeds(sourceFeeds);
  else if (saved?.feeds && saved.feeds.length > 0) setFeeds(saved.feeds);
  else setFeeds([...FALLBACK_FEEDS]);

  setReadArticleIds(saved?.readArticleIds || []);
}

export async function saveState(): Promise<void> {
  if (!storage) return;
  try {
    const state: AppState = { feeds: feeds(), readArticleIds: readArticleIds() };
    await storage.save(STATE_PATH, JSON.stringify(state));
  } catch (e) { console.error('Failed to save state:', e); }
}
