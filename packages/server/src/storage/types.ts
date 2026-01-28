/**
 * Storage types for persistent file storage.
 */

export interface StorageEntry {
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export interface StorageReadResult {
  success: boolean;
  content?: string;
  error?: string;
}

export interface StorageWriteResult {
  success: boolean;
  path: string;
  error?: string;
}

export interface StorageListResult {
  success: boolean;
  entries?: StorageEntry[];
  error?: string;
}

export interface StorageDeleteResult {
  success: boolean;
  path: string;
  error?: string;
}
