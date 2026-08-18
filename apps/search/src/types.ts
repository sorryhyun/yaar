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

/**
 * The last `analyze-deps mode: "mermaid"` diagram, kept so the UI can RENDER it
 * rather than only print its source. `root`/`kind` are what a node label has to be
 * joined with to read the file back, which is what makes a node clickable.
 */
export interface DepsGraph {
  /** Mermaid source, untruncated — the report's copy may be capped for the agent. */
  mermaid: string;
  /** Storage root the node labels are relative to. */
  root: string;
  /** Which storage tree `root` lives in: Search's private clone tree, or shared. */
  kind: 'app' | 'shared';
  /** Human-readable root, as shown in the report. */
  display: string;
  focus: string;
  depth: number;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  /** Node labels that are real source files — the clickable subset (externals are not). */
  files: string[];
  warnings: string[];
}
