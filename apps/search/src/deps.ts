export {};
import { appStorage, storage, AppCommandError, errMsg } from '@bundled/yaar';
import { setState } from './store';
import { clonePath } from './protocol';

/**
 * Source dependency analysis over cloned app source.
 *
 * Clones live in Search's PRIVATE app storage (apps-source/{appId}/…), written by
 * clone-app via appStorage. They are not in the shared yaar://storage/ commons, so
 * this module reads through appStorage for the clone tree and through storage only
 * for an explicit yaar://storage/ path.
 *
 * Parsing is regex over comment-stripped source — no AST, no type resolution. That is
 * enough to answer 'what imports what' for the debugging loop this exists to shorten.
 */

// ── Limits (every mode is bounded; output is read by an agent) ───────────────

const MAX_FILES = 400;
const MAX_DIR_DEPTH = 12;
const MAX_MERMAID_NODES = 60;
const MAX_OUTPUT_CHARS = 8000;
const READ_BATCH = 8;

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXTS = [...SOURCE_EXTS, '.json', '.css'];
const INDEX_NAMES = SOURCE_EXTS.map((e) => `index${e}`);

export type DepMode = 'cycles' | 'impact' | 'summary' | 'mermaid';
export type Direction = 'dependents' | 'dependencies' | 'both';
export type ExternalsMode = 'exclude' | 'leaf';

type EdgeKind = 'import' | 'export' | 'dynamic' | 'require';

interface Edge {
  from: string;
  to: string;
  typeOnly: boolean;
  external: boolean;
  kind: EdgeKind;
}

interface RootRef {
  kind: 'app' | 'shared';
  root: string;
  display: string;
}

interface Graph {
  ref: RootRef;
  files: string[];
  sources: string[];
  edges: Edge[];
  unresolved: { file: string; spec: string }[];
  externals: { spec: string; count: number }[];
  filesTruncated: boolean;
}

interface GraphView {
  nodes: string[];
  nodeSet: Set<string>;
  edges: Edge[];
  adj: Map<string, string[]>;
  radj: Map<string, string[]>;
}

const graphCache = new Map<string, Graph>();

// ── Root resolution ─────────────────────────────────────────────────────────

/**
 * Accepts a clone-tree path ("memo", "apps-source/memo") or an absolute
 * yaar://storage/… / yaar://apps/self/storage/… URI. The clonePath() escape guard is
 * applied to every form that lands in Search's own storage, including the
 * yaar://storage/apps/search/… mirror of it.
 */
export function resolveRoot(input: unknown): RootRef {
  const raw = String(input ?? '').trim();
  if (!raw) throw new AppCommandError('path is required — e.g. "apps-source/memo" or just "memo".');
  let p = raw;
  let shared = false;
  const uri = /^yaar:\/\/(.+)$/i.exec(p);
  if (uri) {
    const selfStore = /^apps\/(?:self|search)\/storage\/?(.*)$/i.exec(uri[1]);
    const sharedStore = /^storage\/?(.*)$/i.exec(uri[1]);
    if (selfStore) {
      p = selfStore[1];
    } else if (sharedStore) {
      p = sharedStore[1];
      shared = true;
    } else {
      throw new AppCommandError(
        `Unsupported URI "${raw}". Use a clone path ("apps-source/memo") or a yaar://storage/… path.`,
      );
    }
  }
  p = p.replace(/^\/+|\/+$/g, '');
  if (p.split('/').some((s) => s === '..')) {
    throw new AppCommandError('path cannot contain "..".');
  }
  if (shared) {
    // yaar://storage/apps/search/… is the storage mirror of Search's own app storage:
    // same tree as the clone root, so it gets the same guard rather than a free pass.
    const mirror = /^apps\/search\/?(.*)$/.exec(p);
    if (mirror) {
      shared = false;
      p = mirror[1];
    }
  }
  if (shared) {
    if (!p) {
      throw new AppCommandError(
        'Refusing to analyze the whole storage root — name a directory, e.g. yaar://storage/shared/foo.',
      );
    }
    return { kind: 'shared', root: p, display: `yaar://storage/${p}` };
  }
  let clone: string;
  try {
    clone = clonePath(p);
  } catch (e: unknown) {
    throw new AppCommandError(errMsg(e));
  }
  if (clone === 'apps-source') {
    throw new AppCommandError(
      'Name one cloned app, e.g. "apps-source/memo" — the whole apps-source/ tree is too large to analyze at once.',
    );
  }
  return { kind: 'app', root: clone, display: clone };
}

function appIdOf(root: string): string {
  return root.replace(/^apps-source\//, '').split('/')[0] || root;
}

// ── File collection ─────────────────────────────────────────────────────────

async function listDir(ref: RootRef, dir: string) {
  const entries =
    ref.kind === 'app'
      ? await appStorage.list(dir)
      : ((await storage.list(dir)) as { path: string; isDirectory: boolean }[]);
  return (entries ?? []) as { path: string; isDirectory: boolean }[];
}

async function readSource(ref: RootRef, rel: string): Promise<string> {
  const full = `${ref.root}/${rel}`;
  if (ref.kind === 'app') return await appStorage.read(full);
  const content = await storage.read(full, { as: 'text' });
  return typeof content === 'string' ? content : String(content);
}

/** Listings return root-relative paths; fall back to joining when only a name comes back. */
function absoluteEntryPath(dir: string, entryPath: string): string {
  const p = String(entryPath ?? '').replace(/^\/+|\/+$/g, '');
  if (!p) return '';
  if (p === dir || p.startsWith(`${dir}/`)) return p;
  const name = p.split('/').pop() ?? '';
  return dir ? `${dir}/${name}` : name;
}

async function collectFiles(ref: RootRef): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const queue: { dir: string; depth: number }[] = [{ dir: ref.root, depth: 0 }];
  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    let entries: { path: string; isDirectory: boolean }[] = [];
    try {
      entries = await listDir(ref, item.dir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const abs = absoluteEntryPath(item.dir, entry.path);
      if (!abs || abs === ref.root) continue;
      if (entry.isDirectory) {
        if (item.depth < MAX_DIR_DEPTH) queue.push({ dir: abs, depth: item.depth + 1 });
        continue;
      }
      if (!abs.startsWith(`${ref.root}/`)) continue;
      if (files.length >= MAX_FILES) {
        truncated = true;
        continue;
      }
      files.push(abs.slice(ref.root.length + 1));
    }
  }
  return { files, truncated };
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Strip comments and replace every string literal with a placeholder token.
 *
 * The placeholders are what make `const s = "import x from './y'"` a non-event: the
 * whole literal collapses to one token, so import-like text inside a string can never
 * look like an import statement. Specifiers are recovered from the token table.
 */
function tokenize(src: string): { code: string; strings: string[] } {
  const strings: string[] = [];
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      let value = '';
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          value += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        i++;
        if (ch === quote) break;
        value += ch;
      }
      out += `${strings.length}`;
      strings.push(value);
      continue;
    }
    out += c;
    i++;
  }
  return { code: out, strings };
}

/** `import type X`, `export type {…}`, and `{ type A, type B }` are type-only. */
function isTypeOnlyClause(clause: string): boolean {
  const c = clause.trim();
  if (!c) return false;
  if (/^type\b/.test(c)) return true;
  const braced = /^\{([\s\S]*)\}$/.exec(c);
  if (!braced) return false;
  const names = braced[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => /^type\s+/.test(name));
}

interface RawImport {
  spec: string;
  typeOnly: boolean;
  kind: EdgeKind;
}

export function parseImports(src: string): RawImport[] {
  const { code, strings } = tokenize(src);
  const out: RawImport[] = [];
  const seen = new Set<string>();
  const push = (token: string, typeOnly: boolean, kind: EdgeKind) => {
    const spec = (strings[Number(token)] ?? '').trim();
    if (!spec) return;
    const key = `${kind}|${spec}|${typeOnly}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ spec, typeOnly, kind });
  };
  let m: RegExpExecArray | null;
  // The clause excludes ; and string tokens, so it cannot run past a bare side-effect
  // import into the next statement's specifier.
  const FROM_RE = /(?:^|[^\w$.])(import|export)\s+([^;]*?)\s*\bfrom\s*(\d+)/g;
  while ((m = FROM_RE.exec(code)) !== null) {
    push(m[3], isTypeOnlyClause(m[2]), m[1] === 'export' ? 'export' : 'import');
  }
  const BARE_RE = /(?:^|[^\w$.])import\s*(\d+)/g;
  while ((m = BARE_RE.exec(code)) !== null) push(m[1], false, 'import');
  const DYN_RE = /(?:^|[^\w$.])import\s*\(\s*(\d+)\s*\)/g;
  while ((m = DYN_RE.exec(code)) !== null) push(m[1], false, 'dynamic');
  const REQ_RE = /(?:^|[^\w$.])require\s*\(\s*(\d+)\s*\)/g;
  while ((m = REQ_RE.exec(code)) !== null) push(m[1], false, 'require');
  return out;
}

// ── Resolution ──────────────────────────────────────────────────────────────

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

export function resolveSpec(fromFile: string, spec: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = normalizePath(`${dirOf(fromFile)}/${spec}`);
  const candidates: string[] = [base];
  // TS ESM writes './foo.js' for a file that is actually foo.ts.
  const jsExt = /\.(js|jsx|mjs|cjs)$/.exec(base);
  if (jsExt) {
    const stem = base.slice(0, base.length - jsExt[0].length);
    for (const e of SOURCE_EXTS) candidates.push(stem + e);
  }
  for (const e of RESOLVE_EXTS) candidates.push(base + e);
  for (const name of INDEX_NAMES) candidates.push(`${base}/${name}`);
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

// ── Graph construction ──────────────────────────────────────────────────────

function addEdge(map: Map<string, Edge>, edge: Edge) {
  const key = `${edge.from} ${edge.to}`;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, edge);
    return;
  }
  // A module imported both as a type and as a value is a real value edge.
  existing.typeOnly = existing.typeOnly && edge.typeOnly;
}

function notClonedError(ref: RootRef): AppCommandError {
  if (ref.kind === 'app') {
    const id = appIdOf(ref.root);
    return new AppCommandError(
      `No cloned source at "${ref.root}". Clone it first: clone-app { appId: "${id}" }, then retry analyze-deps.`,
    );
  }
  return new AppCommandError(`No files under "${ref.display}".`);
}

export async function buildGraph(ref: RootRef, refresh: boolean): Promise<Graph> {
  const key = `${ref.kind}:${ref.root}`;
  if (!refresh) {
    const cached = graphCache.get(key);
    if (cached) return cached;
  }
  const { files, truncated } = await collectFiles(ref);
  if (!files.length) throw notClonedError(ref);
  const fileSet = new Set(files);
  const sources = files.filter((f) => SOURCE_EXTS.some((e) => f.endsWith(e)));
  if (!sources.length) {
    throw new AppCommandError(
      `No JS/TS sources under "${ref.display}" (${files.length} file(s) found). Nothing to graph.`,
    );
  }
  const edgeMap = new Map<string, Edge>();
  const unresolved: { file: string; spec: string }[] = [];
  const externalCounts = new Map<string, number>();
  for (let i = 0; i < sources.length; i += READ_BATCH) {
    const batch = sources.slice(i, i + READ_BATCH);
    const texts = await Promise.all(
      batch.map(async (f) => {
        try {
          return await readSource(ref, f);
        } catch {
          return '';
        }
      }),
    );
    for (let j = 0; j < batch.length; j++) {
      const from = batch[j];
      for (const imp of parseImports(texts[j])) {
        if (!imp.spec.startsWith('.')) {
          externalCounts.set(imp.spec, (externalCounts.get(imp.spec) ?? 0) + 1);
          addEdge(edgeMap, {
            from,
            to: imp.spec,
            typeOnly: imp.typeOnly,
            external: true,
            kind: imp.kind,
          });
          continue;
        }
        const target = resolveSpec(from, imp.spec, fileSet);
        if (!target) {
          unresolved.push({ file: from, spec: imp.spec });
          continue;
        }
        addEdge(edgeMap, {
          from,
          to: target,
          typeOnly: imp.typeOnly,
          external: false,
          kind: imp.kind,
        });
      }
    }
  }
  const graph: Graph = {
    ref,
    files,
    sources,
    edges: [...edgeMap.values()],
    unresolved,
    externals: [...externalCounts.entries()]
      .map(([spec, count]) => ({ spec, count }))
      .sort((a, b) => b.count - a.count || a.spec.localeCompare(b.spec)),
    filesTruncated: truncated,
  };
  graphCache.set(key, graph);
  return graph;
}

function viewOf(
  graph: Graph,
  opts: { includeTypeOnly: boolean; externals: ExternalsMode },
): GraphView {
  const edges = graph.edges.filter(
    (e) => (opts.includeTypeOnly || !e.typeOnly) && (opts.externals === 'leaf' || !e.external),
  );
  const nodeSet = new Set<string>(graph.sources);
  for (const e of edges) {
    nodeSet.add(e.from);
    nodeSet.add(e.to);
  }
  const adj = new Map<string, string[]>();
  const radj = new Map<string, string[]>();
  for (const n of nodeSet) {
    adj.set(n, []);
    radj.set(n, []);
  }
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    radj.get(e.to)?.push(e.from);
  }
  return { nodes: [...nodeSet].sort(), nodeSet, edges, adj, radj };
}

// ── Cycles (Tarjan SCC) ─────────────────────────────────────────────────────

function tarjan(view: GraphView): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;
  const strongconnect = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of view.adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      for (;;) {
        const w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      sccs.push(comp);
    }
  };
  for (const v of view.nodes) if (!index.has(v)) strongconnect(v);
  return sccs;
}

function findCyclePath(view: GraphView, members: string[]): string[] {
  const set = new Set(members);
  const start = members[0];
  const path: string[] = [];
  const visited = new Set<string>();
  const dfs = (v: string): boolean => {
    path.push(v);
    visited.add(v);
    for (const w of view.adj.get(v) ?? []) {
      if (w === start) {
        path.push(start);
        return true;
      }
      if (set.has(w) && !visited.has(w) && dfs(w)) return true;
    }
    path.pop();
    return false;
  };
  return dfs(start) ? path : [...members, start];
}

interface CycleInfo {
  members: string[];
  example: string[];
}

function findCycles(view: GraphView): { cycles: CycleInfo[]; edgeKeys: Set<string> } {
  const cycles: CycleInfo[] = [];
  const edgeKeys = new Set<string>();
  for (const comp of tarjan(view)) {
    if (comp.length > 1) {
      const members = [...comp].sort();
      cycles.push({ members, example: findCyclePath(view, comp) });
      const set = new Set(comp);
      for (const e of view.edges) {
        if (set.has(e.from) && set.has(e.to)) edgeKeys.add(`${e.from} ${e.to}`);
      }
    }
  }
  for (const e of view.edges) {
    if (e.from === e.to) {
      cycles.push({ members: [e.from], example: [e.from, e.from] });
      edgeKeys.add(`${e.from} ${e.to}`);
    }
  }
  cycles.sort((a, b) => b.members.length - a.members.length);
  return { cycles, edgeKeys };
}

// ── Impact (reverse / forward BFS) ──────────────────────────────────────────

function bfs(view: GraphView, start: string, direction: 'dependents' | 'dependencies') {
  const map = direction === 'dependents' ? view.radj : view.adj;
  const seen = new Set<string>([start]);
  const out: { file: string; hops: number }[] = [];
  let frontier = [start];
  let hop = 0;
  while (frontier.length) {
    hop++;
    const next: string[] = [];
    for (const v of frontier) {
      for (const w of map.get(v) ?? []) {
        if (seen.has(w)) continue;
        seen.add(w);
        next.push(w);
        out.push({ file: w, hops: hop });
      }
    }
    frontier = next;
  }
  return out;
}

function resolveFocus(view: GraphView, ref: RootRef, focus: unknown): string {
  const raw = String(focus ?? '')
    .trim()
    .replace(/^\/+/, '');
  if (!raw) throw new AppCommandError('focus is required for this mode.');
  let f = raw;
  if (f.startsWith(`${ref.root}/`)) f = f.slice(ref.root.length + 1);
  if (view.nodeSet.has(f)) return f;
  const suffix = view.nodes.filter((n) => n === f || n.endsWith(`/${f}`));
  if (suffix.length === 1) return suffix[0];
  if (suffix.length > 1) {
    throw new AppCommandError(
      `focus "${raw}" is ambiguous — matches ${suffix.slice(0, 8).join(', ')}. Pass the full path.`,
    );
  }
  const near = view.nodes.filter((n) => n.toLowerCase().includes(f.toLowerCase())).slice(0, 8);
  throw new AppCommandError(
    `focus "${raw}" not found under ${ref.display}.` +
      (near.length ? ` Did you mean: ${near.join(', ')}?` : ''),
  );
}

// ── Mermaid ─────────────────────────────────────────────────────────────────

function mermaidLabel(p: string): string {
  return p.replace(/"/g, "'");
}

function buildMermaid(view: GraphView, focus: string, depth: number, cycleEdges: Set<string>) {
  const dist = new Map<string, number>([[focus, 0]]);
  let frontier = [focus];
  for (let d = 1; d <= depth; d++) {
    const next: string[] = [];
    for (const v of frontier) {
      const neighbours = [...(view.adj.get(v) ?? []), ...(view.radj.get(v) ?? [])];
      for (const w of neighbours) {
        if (dist.has(w)) continue;
        dist.set(w, d);
        next.push(w);
      }
    }
    frontier = next;
  }
  let nodes = [...dist.keys()];
  let truncated = false;
  if (nodes.length > MAX_MERMAID_NODES) {
    nodes = nodes
      .sort((a, b) => (dist.get(a) ?? 0) - (dist.get(b) ?? 0) || a.localeCompare(b))
      .slice(0, MAX_MERMAID_NODES);
    truncated = true;
  }
  const inGraph = new Set(nodes);
  const ids = new Map<string, string>();
  nodes.forEach((n, i) => ids.set(n, `n${i}`));
  const lines = ['graph LR'];
  for (const n of nodes) lines.push(`  ${ids.get(n)}["${mermaidLabel(n)}"]`);
  const cycleIdx: number[] = [];
  let edgeIndex = 0;
  for (const e of view.edges) {
    if (!inGraph.has(e.from) || !inGraph.has(e.to)) continue;
    lines.push(`  ${ids.get(e.from)} ${e.typeOnly ? '-.->' : '-->'} ${ids.get(e.to)}`);
    if (cycleEdges.has(`${e.from} ${e.to}`)) cycleIdx.push(edgeIndex);
    edgeIndex++;
  }
  lines.push(`  style ${ids.get(focus)} stroke:#539bf5,stroke-width:3px`);
  if (cycleIdx.length) {
    lines.push(`  linkStyle ${cycleIdx.join(',')} stroke:#e5534b,stroke-width:2px`);
  }
  return { mermaid: lines.join('\n'), nodeCount: nodes.length, edgeCount: edgeIndex, truncated };
}

// ── Output shaping ──────────────────────────────────────────────────────────

function capResult(result: Record<string, unknown>) {
  for (let guard = 0; guard < 24; guard++) {
    if (JSON.stringify(result).length <= MAX_OUTPUT_CHARS) return result;
    let target: unknown[] | null = null;
    for (const value of Object.values(result)) {
      if (Array.isArray(value) && (!target || value.length > target.length)) target = value;
    }
    if (!target || target.length <= 1) break;
    target.length = Math.max(1, Math.floor(target.length * 0.6));
    result.capped = true;
  }
  return result;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

let lastReport: Record<string, unknown> | null = null;

export function getLastDepsReport() {
  return lastReport;
}

// ── Command entrypoint ──────────────────────────────────────────────────────

const MODES: DepMode[] = ['cycles', 'impact', 'summary', 'mermaid'];
const DIRECTIONS: Direction[] = ['dependents', 'dependencies', 'both'];

export async function analyzeDeps(params: Record<string, unknown>) {
  const mode = String(params.mode ?? '') as DepMode;
  if (!MODES.includes(mode)) {
    throw new AppCommandError(`mode must be one of ${MODES.join(' | ')} (got "${params.mode}").`);
  }
  const ref = resolveRoot(params.path);
  const includeTypeOnly = params.includeTypeOnly === true;
  const externals: ExternalsMode = params.externals === 'leaf' ? 'leaf' : 'exclude';
  const limit = Math.max(1, Math.min(Number(params.limit ?? 10) || 10, 50));
  const direction: Direction = DIRECTIONS.includes(params.direction as Direction)
    ? (params.direction as Direction)
    : 'dependents';

  setState('statusText', `Analyzing ${ref.display} (${mode})…`);
  const graph = await buildGraph(ref, params.refresh === true);
  const view = viewOf(graph, { includeTypeOnly, externals });
  const { cycles, edgeKeys } = findCycles(view);

  const stats = {
    files: graph.files.length,
    modules: view.nodes.length,
    edges: view.edges.length,
    cycles: cycles.length,
    externalPackages: graph.externals.length,
    unresolved: graph.unresolved.length,
  };
  const warnings: string[] = [];
  if (graph.filesTruncated) {
    warnings.push(`File scan stopped at ${MAX_FILES} files — the graph is incomplete.`);
  }
  if (!includeTypeOnly && graph.edges.some((e) => e.typeOnly)) {
    const n = graph.edges.filter((e) => e.typeOnly).length;
    warnings.push(`${n} type-only edge(s) excluded — pass includeTypeOnly: true to include them.`);
  }

  const base: Record<string, unknown> = {
    mode,
    root: ref.display,
    storage: ref.kind === 'app' ? 'search-private' : 'shared',
    stats,
  };
  let result: Record<string, unknown>;
  let text: string;

  if (mode === 'cycles') {
    result = {
      ...base,
      cycleCount: cycles.length,
      cycles: cycles.map((c) => ({
        size: c.members.length,
        members: c.members,
        example: c.example,
      })),
    };
    const lines = [`Dependency cycles — ${ref.display}`, ''];
    lines.push(`${stats.modules} modules, ${stats.edges} edges, ${cycles.length} cycle(s)`, '');
    if (!cycles.length) {
      lines.push('No cycles found.');
    } else {
      cycles.forEach((c, i) => {
        lines.push(`${i + 1}. (${c.members.length} files) ${c.example.join(' → ')}`);
      });
    }
    text = lines.join('\n');
  } else if (mode === 'impact') {
    const focus = resolveFocus(view, ref, params.focus);
    const wantDependents = direction === 'dependents' || direction === 'both';
    const wantDependencies = direction === 'dependencies' || direction === 'both';
    const dependents = wantDependents ? bfs(view, focus, 'dependents') : [];
    const dependencies = wantDependencies ? bfs(view, focus, 'dependencies') : [];
    result = {
      ...base,
      focus,
      direction,
      dependentCount: dependents.length,
      dependencyCount: dependencies.length,
      dependents: wantDependents ? dependents : undefined,
      dependencies: wantDependencies ? dependencies : undefined,
    };
    const lines = [`Impact of ${focus} — ${ref.display}`, ''];
    const section = (title: string, rows: { file: string; hops: number }[]) => {
      lines.push(`${title} (${rows.length})`);
      if (!rows.length) {
        lines.push('  none');
      } else {
        const byHop = new Map<number, string[]>();
        for (const r of rows) {
          const arr = byHop.get(r.hops) ?? [];
          arr.push(r.file);
          byHop.set(r.hops, arr);
        }
        for (const h of [...byHop.keys()].sort((a, b) => a - b)) {
          lines.push(`  hop ${h}: ${(byHop.get(h) ?? []).join(', ')}`);
        }
      }
      lines.push('');
    };
    if (wantDependents) section('DEPENDENTS — files that reach this one', dependents);
    if (wantDependencies) section('DEPENDENCIES — files this one reaches', dependencies);
    text = lines.join('\n');
  } else if (mode === 'summary') {
    const fanIn = view.nodes
      .map((n) => ({ file: n, count: (view.radj.get(n) ?? []).length }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
      .slice(0, limit);
    const fanOut = view.nodes
      .map((n) => ({ file: n, count: (view.adj.get(n) ?? []).length }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
      .slice(0, limit);
    const entrypoints = view.nodes.filter(
      (n) => (view.radj.get(n) ?? []).length === 0 && (view.adj.get(n) ?? []).length > 0,
    );
    const orphans = view.nodes.filter(
      (n) => (view.radj.get(n) ?? []).length === 0 && (view.adj.get(n) ?? []).length === 0,
    );
    result = {
      ...base,
      fanIn,
      fanOut,
      entrypoints,
      orphans,
      externals: graph.externals.slice(0, limit),
      unresolved: graph.unresolved.slice(0, 40),
    };
    const lines = [`Dependency summary — ${ref.display}`, ''];
    lines.push(
      `${stats.modules} modules · ${stats.edges} edges · ${stats.cycles} cycles · ` +
        `${stats.externalPackages} external packages · ${stats.unresolved} unresolved`,
      '',
    );
    lines.push('TOP FAN-IN (most depended on)');
    if (!fanIn.length) lines.push('  none');
    for (const r of fanIn) lines.push(`  ${pad(String(r.count), 4)}${r.file}`);
    lines.push('', 'TOP FAN-OUT (imports the most)');
    if (!fanOut.length) lines.push('  none');
    for (const r of fanOut) lines.push(`  ${pad(String(r.count), 4)}${r.file}`);
    lines.push('', `ENTRY POINTS — nothing imports them (${entrypoints.length})`);
    lines.push(entrypoints.length ? `  ${entrypoints.join(', ')}` : '  none');
    lines.push('', `ORPHANS — no imports in or out (${orphans.length})`);
    lines.push(orphans.length ? `  ${orphans.join(', ')}` : '  none');
    if (graph.unresolved.length) {
      lines.push('', `UNRESOLVED IMPORTS (${graph.unresolved.length})`);
      for (const u of graph.unresolved.slice(0, 20)) lines.push(`  ${u.file} → ${u.spec}`);
    }
    text = lines.join('\n');
  } else {
    if (params.focus == null || String(params.focus).trim() === '') {
      throw new AppCommandError(
        'mermaid mode requires focus — a whole-app graph is unreadable. Pass focus and depth.',
      );
    }
    if (params.depth == null || !Number.isFinite(Number(params.depth))) {
      throw new AppCommandError('mermaid mode requires depth (1-4 hops around focus).');
    }
    const depth = Math.max(1, Math.min(Math.floor(Number(params.depth)), 4));
    const focus = resolveFocus(view, ref, params.focus);
    const built = buildMermaid(view, focus, depth, edgeKeys);
    result = {
      ...base,
      focus,
      depth,
      nodeCount: built.nodeCount,
      edgeCount: built.edgeCount,
      truncated: built.truncated,
      legend: 'solid = value import, dotted = type-only, red = cycle edge',
      mermaid: built.mermaid,
    };
    text = built.mermaid;
  }

  if (warnings.length) result.warnings = warnings;
  if (typeof result.mermaid === 'string' && result.mermaid.length > MAX_OUTPUT_CHARS) {
    result.mermaid = `${result.mermaid.slice(0, MAX_OUTPUT_CHARS)}\n%% …truncated`;
    result.capped = true;
  }
  const capped = capResult(result);
  lastReport = capped;

  const header = warnings.length ? `${warnings.map((w) => `! ${w}`).join('\n')}\n\n` : '';
  setState('selectedIndex', null);
  setState('previewHighlightLine', null);
  setState('previewPath', `deps · ${mode} · ${ref.display}`);
  setState('previewContent', header + text);
  setState(
    'statusText',
    `${mode}: ${stats.modules} modules, ${stats.edges} edges, ${stats.cycles} cycle(s)`,
  );
  return capped;
}
