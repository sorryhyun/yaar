export {};

export interface StorageEntry {
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
}
