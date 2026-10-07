export {};

export interface StorageEntry {
  path: string;
  isDirectory: boolean;
  /** Bytes. Meaningless for a directory (0, or the filesystem's block size). */
  size?: number;
  /** ISO timestamp of the last write. */
  modifiedAt?: string;
}
