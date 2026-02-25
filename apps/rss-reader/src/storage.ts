import { AppState } from './types';
import { store } from './store';

declare const yaar: {
  storage: {
    save(path: string, data: string | Blob | ArrayBuffer | Uint8Array): Promise<void>;
    read(path: string, opts?: { as?: 'text' | 'blob' | 'arraybuffer' | 'json' | 'auto' }): Promise<any>;
    list(dirPath?: string): Promise<Array<{ path: string; isDirectory: boolean; size: number; modifiedAt: string }>>;
    remove(path: string): Promise<void>;
    url(path: string): string;
  };
};

const STORAGE_PATH = 'rss-reader/feeds.json';

export async function loadState(): Promise<void> {
  try {
    const data = await yaar.storage.read(STORAGE_PATH, { as: 'json' });
    if (data && data.feeds) {
      const saved = data as AppState;
      store.feeds = saved.feeds;
      store.readArticleIds = saved.readArticleIds || [];
    }
  } catch {
    // Use defaults
  }
}

export async function saveState(): Promise<void> {
  try {
    const state: AppState = {
      feeds: store.feeds,
      readArticleIds: store.readArticleIds,
    };
    await yaar.storage.save(STORAGE_PATH, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}
