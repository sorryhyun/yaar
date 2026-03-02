export {};

export interface StorageEntry {
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
}

export interface StorageSDK {
  list(path: string): Promise<StorageEntry[]>;
  read(path: string, opts?: { as?: string }): Promise<string>;
  save(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  url(path: string): string;
}

export interface AppSDK {
  register(config: {
    appId: string;
    name: string;
    state: Record<string, { description: string; handler: () => unknown }>;
    commands: Record<string, { description: string; params?: unknown; handler: (params: Record<string, unknown>) => unknown }>;
  }): void;
  sendInteraction?: (payload: unknown) => void;
}
