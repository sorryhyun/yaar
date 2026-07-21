/**
 * Storage types for persistent file storage.
 */

export interface StorageEntry {
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export interface StorageImageContent {
  type: 'image';
  data: string; // base64 encoded
  mimeType: string;
  pageNumber?: number;
}

export interface StorageReadResult {
  success: boolean;
  content?: string;
  images?: StorageImageContent[];
  totalPages?: number;
  /** Set for PDFs. When true, the result carries metadata only (no rasterized images) and the
   *  caller should steer the agent to open the PDF in a viewer window instead of ingesting it. */
  pdfMeta?: boolean;
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

export interface StorageGrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface StorageGrepResult {
  success: boolean;
  matches?: StorageGrepMatch[];
  truncated?: boolean;
  error?: string;
}
