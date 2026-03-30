export interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}

export interface CloneResult {
  success: boolean;
  error?: string;
  files?: { path: string; content: string }[];
  meta?: { name: string; icon: string; description: string };
}
