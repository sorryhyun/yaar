/**
 * Type declarations for the window.yaar API surface.
 *
 * Sandbox apps (compiled via the `compile` tool) can access `window.yaar`
 * for app protocol registration, storage, and notifications.
 * These types eliminate the need for `(window as any).yaar` casts.
 */

// ── App Protocol ────────────────────────────────────────────────

interface YaarAppStateDescriptor<T = unknown> {
  description: string;
  handler: () => T | Promise<T>;
  schema?: object;
}

interface YaarAppCommandDescriptor<P = unknown, R = unknown> {
  description: string;
  aliases?: string[];
  handler: (params: P) => R | Promise<R>;
  params?: object;
  returns?: object;
}

interface YaarAppRegistration {
  appId: string;
  name: string;
  state: Record<string, YaarAppStateDescriptor>;
  commands: Record<string, YaarAppCommandDescriptor>;
}

interface YaarApp {
  register(config: YaarAppRegistration): void;
  sendInteraction(description: string | (Record<string, unknown> & { instructions?: string })): void;
}

// ── Storage SDK ─────────────────────────────────────────────────

interface YaarStorageReadOptions {
  as?: 'text' | 'json' | 'blob' | 'arraybuffer' | 'auto';
}

interface YaarStorage {
  save(path: string, data: string | Blob | ArrayBuffer | Uint8Array): Promise<{ ok: boolean }>;
  read(path: string, options?: YaarStorageReadOptions): Promise<unknown>;
  list(dirPath?: string): Promise<string[]>;
  remove(path: string): Promise<{ ok: boolean }>;
  url(path: string): string;
}

// ── Notifications SDK ───────────────────────────────────────────

interface YaarNotificationItem {
  id: string;
  title?: string;
  body?: string;
  [key: string]: unknown;
}

interface YaarNotifications {
  list(): YaarNotificationItem[];
  count(): number;
  onChange(callback: (items: YaarNotificationItem[]) => void): () => void;
}

// ── Windows SDK (read-only) ──────────────────────────────────────

interface YaarWindowReadOptions {
  includeImage?: boolean;
}

interface YaarWindowReadResult {
  id: string;
  title: string;
  renderer: string;
  content: unknown;
  imageData?: string;
}

interface YaarWindowListItem {
  id: string;
  title: string;
  renderer: string;
}

interface YaarWindows {
  read(windowId: string, options?: YaarWindowReadOptions): Promise<YaarWindowReadResult>;
  list(): Promise<YaarWindowListItem[]>;
}

// ── Verb SDK ─────────────────────────────────────────────────────

interface YaarVerbResultContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

interface YaarVerbResult {
  content: YaarVerbResultContent[];
  isError?: boolean;
}

// ── Global ──────────────────────────────────────────────────────

interface YaarGlobal {
  app: YaarApp;
  storage: YaarStorage;
  notifications: YaarNotifications;
  windows: YaarWindows;

  /** Execute an action on a yaar:// resource. */
  invoke(uri: string, payload?: Record<string, unknown>): Promise<YaarVerbResult>;
  /** Read the current value/state of a yaar:// resource. */
  read(uri: string): Promise<YaarVerbResult>;
  /** List child resources under a yaar:// URI. */
  list(uri: string): Promise<YaarVerbResult>;
  /** Describe a yaar:// resource (supported verbs, schema). */
  describe(uri: string): Promise<YaarVerbResult>;
  /** Delete a yaar:// resource. */
  delete(uri: string): Promise<YaarVerbResult>;
}

interface Window {
  yaar?: YaarGlobal;
}
