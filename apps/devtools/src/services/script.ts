export {};
import { AppCommandError, errMsg, invoke } from '@bundled/yaar';
import { previewWindowId } from '../core';
import { previewStaleNote, previewWindowIsOpen } from './preview';
import { readFileText, writeFile } from './files';

// Scripted regression runs against the preview: execute a recorded sequence of
// protocol commands, project each result down to the fields the script names, and
// compare against a baseline captured on a known-good build. The runner owns the
// comparison so a mismatch lands in the tool result — the alternative, observed in
// practice, is an agent driving the same commands by hand across dozens of turns
// and then being the sole judge of whether the numbers moved.

/** Where a script's baseline lives when the script does not say: next to it. */
function defaultBaselinePath(scriptPath: string): string {
  const dir = scriptPath.includes('/') ? scriptPath.slice(0, scriptPath.lastIndexOf('/')) : '';
  return dir ? `${dir}/baseline.json` : 'baseline.json';
}

const DEFAULT_SCRIPT_PATH = 'test/regression.json';
/** Serialized chars kept per recorded row. Truncation is deterministic, so a capped
 * row still compares stably — it just compares on its prefix. */
const ROW_CHARS = 4000;
/** Serialized chars of expected/actual shown per failure in the report. */
const REPORT_CHARS = 800;
/** Failures listed in full before the rest are counted, not shown. */
const MAX_REPORTED_FAILURES = 20;

/** Recorded absence: a `pick` path that resolved to nothing. A named marker rather
 * than `null`, because "the field is null" and "the field is gone" are different
 * regressions and the second is the one a refactor introduces. */
const MISSING = '<missing>';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface ParsedStep {
  index: number;
  kind: 'command' | 'eval' | 'resize';
  command?: string;
  params?: Record<string, unknown>;
  expression?: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
  label: string;
  group?: string;
  record: boolean;
  pick?: string[];
  round?: number;
}

interface ParsedScript {
  baselinePath: string;
  round?: number;
  steps: ParsedStep[];
  groups: string[];
}

interface BaselineRow {
  label: string;
  group?: string;
  value: Json;
}

interface BaselineFile {
  script: string;
  results: BaselineRow[];
}

/**
 * Sorted keys, optional float rounding, `undefined` collapsed to null. Everything
 * recorded has already crossed the iframe bridge as JSON, so there are no cycles
 * or functions to defend against — the job here is only that the same measurement
 * serializes to the same bytes on every run.
 */
function normalize(value: unknown, round?: number): Json {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return round !== undefined && !Number.isInteger(value) ? Number(value.toFixed(round)) : value;
  }
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => normalize(v, round));
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(src).sort()) out[key] = normalize(src[key], round);
    return out;
  }
  return String(value);
}

/** Resolve one dot-path (`saved.verts`, `meshes.0.name`) into a result. */
function pickPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return MISSING;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return MISSING;
  }
  return cur;
}

function capRow(value: Json): Json {
  const text = JSON.stringify(value);
  return text.length > ROW_CHARS ? { $truncated: text.slice(0, ROW_CHARS) } : value;
}

function reportValue(value: Json): string {
  const text = JSON.stringify(value);
  return text.length > REPORT_CHARS ? `${text.slice(0, REPORT_CHARS)}…` : text;
}

function fail(index: number, message: string): never {
  throw new AppCommandError(`Script step ${index}: ${message}`);
}

/**
 * Parse and validate the whole script before running any of it. A script that
 * half-ran before its step 31 turned out malformed has already mutated the app
 * under test, and the re-run then starts from state the fixtures did not build.
 */
function parseScript(scriptPath: string, text: string): ParsedScript {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppCommandError(`${scriptPath} is not valid JSON: ${errMsg(err)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppCommandError(`${scriptPath} must be a JSON object with a "steps" array.`);
  }
  const doc = raw as Record<string, unknown>;
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    throw new AppCommandError(`${scriptPath} has no steps. "steps" must be a non-empty array.`);
  }
  const scriptRound = typeof doc.round === 'number' ? doc.round : undefined;
  const groups: string[] = [];
  const steps = doc.steps.map((entry, index): ParsedStep => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(index, 'each step must be an object.');
    }
    const s = entry as Record<string, unknown>;
    const kinds = ['command', 'eval', 'resize'].filter((k) => s[k] !== undefined);
    if (kinds.length !== 1) {
      fail(index, `a step carries exactly one of "command", "eval", "resize" — found ${kinds.length}.`);
    }
    const group = typeof s.group === 'string' ? s.group : undefined;
    if (group && !groups.includes(group)) groups.push(group);
    const pick = Array.isArray(s.pick) ? s.pick.map((p) => String(p)) : undefined;
    const round = typeof s.round === 'number' ? s.round : scriptRound;
    const base = {
      index,
      ...(typeof s.timeoutMs === 'number' ? { timeoutMs: s.timeoutMs } : {}),
      ...(group ? { group } : {}),
      ...(pick ? { pick } : {}),
      ...(round !== undefined ? { round } : {}),
    };
    if (s.resize !== undefined) {
      const size = s.resize;
      if (!Array.isArray(size) || size.length !== 2) {
        fail(index, '"resize" must be [width, height].');
      }
      const width = Number(size[0]);
      const height = Number(size[1]);
      if (!(width > 0) || !(height > 0)) {
        fail(index, '"resize" must be [width, height] with positive numbers.');
      }
      // A resize is harness setup, never a measurement — recording the window
      // acknowledgment would make every baseline row after it shift on a rename.
      return {
        ...base,
        kind: 'resize',
        width,
        height,
        label: typeof s.label === 'string' ? s.label : `#${index} resize`,
        record: false,
      };
    }
    if (s.eval !== undefined) {
      if (typeof s.eval !== 'string' || !s.eval.trim()) fail(index, '"eval" must be an expression string.');
      return {
        ...base,
        kind: 'eval',
        expression: s.eval,
        label: typeof s.label === 'string' ? s.label : `#${index} eval`,
        record: s.record !== false,
      };
    }
    if (typeof s.command !== 'string' || !s.command.trim()) {
      fail(index, '"command" must be a command name string.');
    }
    if (s.params !== undefined && (s.params === null || typeof s.params !== 'object')) {
      fail(index, '"params" must be an object.');
    }
    return {
      ...base,
      kind: 'command',
      command: s.command,
      params: (s.params as Record<string, unknown>) ?? {},
      label: typeof s.label === 'string' ? s.label : `#${index} ${s.command}`,
      record: s.record !== false,
    };
  });
  return {
    baselinePath:
      typeof doc.baseline === 'string' ? doc.baseline : defaultBaselinePath(scriptPath),
    ...(scriptRound !== undefined ? { round: scriptRound } : {}),
    steps,
    groups,
  };
}

async function executeStep(wid: string, step: ParsedStep): Promise<unknown> {
  if (step.kind === 'resize') {
    return await invoke(`yaar://windows/${wid}`, {
      action: 'resize',
      width: step.width,
      height: step.height,
    });
  }
  if (step.kind === 'eval') {
    const raw = await invoke<unknown>(`yaar://windows/${wid}`, {
      action: 'app_eval',
      expression: step.expression,
      ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
    });
    // app_eval hands back the iframe's serialized result; parse it so the recorded
    // value is the value, not a JSON string that re-quotes on every nesting level.
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  }
  return await invoke(`yaar://windows/${wid}`, {
    action: 'app_command',
    command: step.command,
    params: step.params ?? {},
    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
  });
}

export interface ScriptRunOptions {
  path?: string;
  update?: boolean;
  groups?: string[];
}

export interface ScriptFailure {
  step: string;
  group?: string;
  expected: string;
  actual: string;
}

export interface ScriptRunResult {
  mode: 'captured' | 'compared' | 'updated';
  script: string;
  baseline: string;
  stepsRun: number;
  rowsRecorded: number;
  pass?: boolean;
  failures?: ScriptFailure[];
  failuresOmitted?: number;
  /** Compared/updated only: rows whose value moved since the stored baseline. */
  changed?: string[];
  /** The script and the baseline no longer line up row-for-row — nothing was value-compared. */
  structureMismatch?: string;
  note?: string;
}

function parseBaseline(baselinePath: string, text: string): BaselineFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppCommandError(
      `${baselinePath} is not valid JSON (${errMsg(err)}). Fix it, or re-capture with update: true.`,
    );
  }
  const doc = raw as { script?: unknown; results?: unknown };
  if (!Array.isArray(doc?.results)) {
    throw new AppCommandError(
      `${baselinePath} is not a previewScript baseline (no "results" array). ` +
        'Point the script\'s "baseline" field elsewhere, or re-capture with update: true.',
    );
  }
  return { script: String(doc.script ?? ''), results: doc.results as BaselineRow[] };
}

/** Which rows a groups-filtered run covers: ungrouped rows always, grouped rows when named. */
function inGroups(group: string | undefined, groups?: string[]): boolean {
  return !groups || !group || groups.includes(group);
}

export async function runPreviewScript(opts: ScriptRunOptions): Promise<ScriptRunResult> {
  const wid = previewWindowId();
  if (!wid || !(await previewWindowIsOpen())) {
    throw new AppCommandError('No preview window open. Run compile, then preview, then this.');
  }
  // A stale preview is a hard refusal, not a warning: the entire value of the run is
  // knowing which build the numbers describe, and a warning riding along with 40
  // passing rows is exactly the kind that gets read as noise.
  const stale = previewStaleNote();
  if (stale) {
    throw new AppCommandError(`${stale}\nA regression run against a stale preview measures the wrong build.`);
  }

  const scriptPath = opts.path ?? DEFAULT_SCRIPT_PATH;
  const text = await readFileText(scriptPath);
  if (text === null) {
    throw new AppCommandError(
      `No script at ${scriptPath}. Write one first — the regression-testing doc topic has the format.`,
    );
  }
  const script = parseScript(scriptPath, text);

  const groups = opts.groups?.map((g) => String(g));
  if (groups) {
    const unknown = groups.filter((g) => !script.groups.includes(g));
    if (unknown.length > 0) {
      throw new AppCommandError(
        `Unknown group(s) ${unknown.join(', ')}. The script declares: ${
          script.groups.length > 0 ? script.groups.join(', ') : '(none)'
        }.`,
      );
    }
    if (opts.update) {
      // A partial run cannot stand in for the whole baseline, and patching rows into
      // one file across runs would blend measurements of different builds.
      throw new AppCommandError('update: true requires a full run — drop "groups".');
    }
  }

  const toRun = script.steps.filter((s) => inGroups(s.group, groups));
  const rows: BaselineRow[] = [];
  for (const step of toRun) {
    let value: unknown;
    try {
      value = await executeStep(wid, step);
    } catch (err) {
      // Recorded, not thrown: "this step now errors" is a comparable finding, and
      // later groups are self-contained enough to still be worth measuring.
      value = { error: errMsg(err) };
    }
    if (!step.record) continue;
    const projected = step.pick
      ? Object.fromEntries(step.pick.map((p) => [p, pickPath(value, p)]))
      : value;
    rows.push({
      label: step.label,
      ...(step.group ? { group: step.group } : {}),
      value: capRow(normalize(projected, step.round)),
    });
  }

  const baselineText = await readFileText(script.baselinePath);
  const summary = {
    script: scriptPath,
    baseline: script.baselinePath,
    stepsRun: toRun.length,
    rowsRecorded: rows.length,
  };

  const writeBaseline = async () => {
    await writeFile(
      script.baselinePath,
      JSON.stringify({ script: scriptPath, results: rows }, null, 2),
      { label: 'previewScript baseline' },
    );
  };

  if (baselineText === null) {
    if (groups) {
      throw new AppCommandError(
        `No baseline at ${script.baselinePath}, and a groups-filtered run cannot capture one. ` +
          'Run once without "groups" on a known-good build first.',
      );
    }
    await writeBaseline();
    return {
      mode: 'captured',
      ...summary,
      note:
        'No baseline existed, so this run wrote it. These rows now define expected behavior — ' +
        'capture on a build you trust, and re-run after changes to compare.',
    };
  }

  const baseline = parseBaseline(script.baselinePath, baselineText);
  const expectedRows = baseline.results.filter((r) => inGroups(r?.group, groups));

  // Rows pair up positionally, verified by label. A script edited since capture is
  // reported as drift and not value-compared: pairing rows by guesswork would report
  // real regressions against the wrong expectations.
  const misaligned =
    rows.length !== expectedRows.length
      ? `this run recorded ${rows.length} rows, the baseline holds ${expectedRows.length}`
      : rows
          .map((row, i) =>
            row.label !== expectedRows[i]?.label
              ? `row ${i} is "${row.label}" here but "${expectedRows[i]?.label}" in the baseline`
              : null,
          )
          .find((m) => m !== null);
  if (misaligned) {
    return {
      mode: 'compared',
      ...summary,
      pass: false,
      structureMismatch:
        `${misaligned}. The script changed since the baseline was captured — verify current ` +
        'behavior on a known-good build and re-capture with update: true.',
    };
  }

  const failures: ScriptFailure[] = [];
  const changed: string[] = [];
  rows.forEach((row, i) => {
    const expected = expectedRows[i];
    if (!expected) return;
    const want = JSON.stringify(normalize(expected.value));
    const got = JSON.stringify(row.value);
    if (want === got) return;
    changed.push(row.label);
    failures.push({
      step: row.label,
      ...(row.group ? { group: row.group } : {}),
      expected: reportValue(normalize(expected.value)),
      actual: reportValue(row.value),
    });
  });

  if (opts.update) {
    await writeBaseline();
    return {
      mode: 'updated',
      ...summary,
      ...(changed.length > 0 ? { changed } : {}),
      note:
        changed.length > 0
          ? 'Baseline rewritten. "changed" lists the rows whose expected value moved — each should be an intended behavior change.'
          : 'Baseline rewritten; no row differed from the previous baseline.',
    };
  }

  const shown = failures.slice(0, MAX_REPORTED_FAILURES);
  return {
    mode: 'compared',
    ...summary,
    pass: failures.length === 0,
    ...(shown.length > 0 ? { failures: shown } : {}),
    ...(failures.length > shown.length ? { failuresOmitted: failures.length - shown.length } : {}),
  };
}
