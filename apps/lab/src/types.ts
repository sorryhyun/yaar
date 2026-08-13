export type CellType = 'code' | 'markdown';

export interface OutputPart {
  kind: 'text' | 'json' | 'table' | 'chart' | 'graph' | 'image' | 'error' | 'markdown';
  // text
  text?: string;
  truncated?: boolean;
  // json
  json?: string;
  // table
  columns?: string[];
  rows?: unknown[][];
  totalRows?: number;
  // chart
  spec?: ChartSpec;
  // graph
  graph?: GraphSpec;
  // image
  src?: string;
  // error
  name?: string;
  message?: string;
  stack?: string;
}

export interface ChartSpec {
  __labChart: true;
  type: 'line' | 'bar' | 'scatter' | 'pie' | 'doughnut';
  data: { labels: string[]; datasets: { label: string; data: unknown[] }[] };
  options: {
    title?: string;
    xLabel?: string;
    yLabel?: string;
    stacked?: boolean;
    horizontal?: boolean;
    fill?: boolean;
    legend?: boolean;
    height?: number;
    colors?: string[] | null;
    beginAtZero?: boolean;
  };
}

/**
 * One curve in a graph. Exactly one of `expr` / `points` is meaningful:
 *
 * - `expr` is a source string, parsed and compiled **in the renderer**, so panning
 *   and zooming re-sample it at the new viewport. This is the interactive case.
 * - `points` is an eagerly sampled polyline, which is all a JS function input can
 *   become: closures cannot cross the worker boundary. Such a series carries
 *   `resample: false` and is drawn as given.
 */
export interface GraphSeries {
  expr?: string;
  points?: (number[] | null)[];
  resample?: boolean;
  color?: string;
  label?: string;
  tMin?: number;
  tMax?: number;
}

/**
 * A function-graph spec. Serializable by construction — it crosses from the Web
 * Worker to the window by structured clone, so it holds strings and numbers only.
 */
export interface GraphSpec {
  __labGraph: true;
  series: GraphSeries[];
  options: {
    xMin?: number;
    xMax?: number;
    yMin?: number;
    yMax?: number;
    params?: Record<string, number>;
    equalAspect?: boolean;
    grid?: boolean;
    title?: string;
    height?: number;
    colors?: string[] | null;
  };
}

export interface LogEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

export interface CellOutput {
  ok: boolean;
  logs: LogEntry[];
  parts: OutputPart[];
  durationMs: number;
  error?: { name: string; message: string; stack: string };
  at: number;
}

export interface Cell {
  id: string;
  type: CellType;
  source: string;
  output?: CellOutput;
  editing?: boolean;
}

export interface Notebook {
  id: string;
  title: string;
  cells: Cell[];
  createdAt: number;
  updatedAt: number;
}

export interface NotebookMeta {
  id: string;
  title: string;
  updatedAt: number;
  cellCount: number;
}

/**
 * One execution that arrived over the app protocol, kept for the Agent runs panel
 * so an agent-driven run is never invisible in the window. `output` is the same
 * shape a cell renders, so OutputView draws both.
 */
export interface AgentRun {
  id: string;
  at: number;
  kind: 'runCode' | 'runCell' | 'runAll';
  cellId?: string;
  source: string;
  ok: boolean;
  durationMs: number;
  summary: string;
  output?: CellOutput;
  savedTo?: string;
  saveError?: string;
  error?: string;
  truncated?: boolean;
}

/** What the worker sends back for one execution. */
export interface RunResult {
  ok: boolean;
  logs: LogEntry[];
  parts: OutputPart[];
  durationMs: number;
  error?: { name: string; message: string; stack: string };
  hasChart?: boolean;
  hasGraph?: boolean;
  savedTo?: string;
  saveError?: string;
  agent?: {
    result: unknown;
    resultType: string;
    truncated: boolean;
    shape?: unknown;
    note?: string;
  };
}
