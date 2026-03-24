import { appStorage, createPersistedSignal } from '@bundled/yaar';
import type { AppState, Feed } from './types';
import { FALLBACK_FEEDS, state, setState } from './store';
import { extractDomainName } from './utils';

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
  for (const path of FEED_SOURCE_PATHS) {
    try {
      const text = await appStorage.read(path);
      const parsed = parseFeedSourcesText(String(text || ''));
      if (parsed.length > 0) return parsed;
    } catch { /* missing file ok */ }
  }
  return null;
}

// Persisted signal: auto-saves AppState on every setAppState() call — no null guard needed
const [, setAppState] = createPersistedSignal<AppState>(STATE_PATH, {
  feeds: [...FALLBACK_FEEDS],
  readArticleIds: [],
});

export async function loadState(): Promise<void> {
  const saved = await appStorage.readJsonOr<AppState | null>(STATE_PATH, null);

  const sourceFeeds = await loadFeedsFromSourceFile();
  if (sourceFeeds && sourceFeeds.length > 0) setState('feeds', sourceFeeds);
  else if (saved?.feeds && saved.feeds.length > 0) setState('feeds', saved.feeds);
  else setState('feeds', [...FALLBACK_FEEDS]);

  setState('readArticleIds', saved?.readArticleIds ?? []);
}

// Synchronises current signal state to storage. Kept async for call-site compatibility.
export async function saveState(): Promise<void> {
  setAppState({ feeds: state.feeds, readArticleIds: state.readArticleIds });
}
