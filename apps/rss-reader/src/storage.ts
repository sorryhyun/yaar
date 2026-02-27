import { AppState, Feed } from './types';
import { FALLBACK_FEEDS, store } from './store';
import { extractDomainName } from './utils';

declare const yaar: {
  storage: {
    save(path: string, data: string | Blob | ArrayBuffer | Uint8Array): Promise<void>;
    read(path: string, opts?: { as?: 'text' | 'blob' | 'arraybuffer' | 'json' | 'auto' }): Promise<any>;
    list(dirPath?: string): Promise<Array<{ path: string; isDirectory: boolean; size: number; modifiedAt: string }>>;
    remove(path: string): Promise<void>;
    url(path: string): string;
  };
};

const STATE_PATH = 'rss-reader/feeds.json';
const FEED_SOURCE_PATHS = [
  'rss-reader/feeds.txt',
  'rss-reader/feed-sources.txt',
];

function hashToId(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    hash = hash >>> 0;
  }
  return `src_${hash.toString(36)}`;
}

function parseFeedSourcesText(text: string): Feed[] {
  const feeds: Feed[] = [];
  const seenUrls = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let name = '';
    let url = '';

    const pipeIdx = line.indexOf('|');
    if (pipeIdx > 0) {
      name = line.slice(0, pipeIdx).trim();
      url = line.slice(pipeIdx + 1).trim();
    } else {
      const commaIdx = line.indexOf(',');
      if (commaIdx > 0 && /^https?:\/\//i.test(line.slice(commaIdx + 1).trim())) {
        name = line.slice(0, commaIdx).trim();
        url = line.slice(commaIdx + 1).trim();
      } else {
        url = line;
      }
    }

    try {
      const normalized = new URL(url).toString();
      if (seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);
      feeds.push({
        id: hashToId(normalized),
        name: name || extractDomainName(normalized),
        url: normalized,
      });
    } catch {
      // Ignore invalid source line
    }
  }

  return feeds;
}

async function loadFeedsFromSourceFile(): Promise<Feed[] | null> {
  for (const path of FEED_SOURCE_PATHS) {
    try {
      const text = await yaar.storage.read(path, { as: 'text' });
      const parsed = parseFeedSourcesText(String(text || ''));
      if (parsed.length > 0) {
        return parsed;
      }
    } catch {
      // Missing source file is expected on first run
    }
  }

  return null;
}

export async function loadState(): Promise<void> {
  let saved: AppState | null = null;

  try {
    const data = await yaar.storage.read(STATE_PATH, { as: 'json' });
    if (data && typeof data === 'object') {
      saved = data as AppState;
    }
  } catch {
    // Use defaults
  }

  const sourceFeeds = await loadFeedsFromSourceFile();
  if (sourceFeeds && sourceFeeds.length > 0) {
    store.feeds = sourceFeeds;
  } else if (saved?.feeds && saved.feeds.length > 0) {
    store.feeds = saved.feeds;
  } else {
    store.feeds = [...FALLBACK_FEEDS];
  }

  store.readArticleIds = saved?.readArticleIds || [];
}

export async function saveState(): Promise<void> {
  try {
    const state: AppState = {
      feeds: store.feeds,
      readArticleIds: store.readArticleIds,
    };
    await yaar.storage.save(STATE_PATH, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}
