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

// Under src/, because deploy ships only src/, agent/ and the root files — a suite at a
// top-level test/ is dropped from the deployed app silently.
const DEFAULT_SCRIPT_PATH = 'src/test/regression.json';
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
  kind: 'command' | 'eval' | 'resize' | 'state';
  command?: string;
  params?: Record<string, unknown>;
  expression?: string;
  stateKey?: string;
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

function fail(index: number, message: string, label?: string): never {
  throw new AppCommandError(`Script step ${index}${label ? ` (${label})` : ''}: ${message}`);
}

/** Key a row by label, numbering repeats, so duplicate labels still pair up 1:1. */
function rowKeys(rows: BaselineRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const n = seen.get(r.label) ?? 0;
    seen.set(r.label, n + 1);
    return n === 0 ? r.label : `${r.label} (${n + 1})`;
  });
}

interface RowDelta {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Compare two row lists by label rather than by position, so a step inserted in the
 * middle reports as one addition instead of shifting every row after it into
 * `changed`. This is what makes an `update: true` over a restructured script
 * readable: the caller needs to see what arrived and what left, not a wall of
 * off-by-one diffs.
 */
function diffRows(before: BaselineRow[], after: BaselineRow[]): RowDelta {
  const beforeKeys = rowKeys(before);
  const afterKeys = rowKeys(after);
  const beforeBy = new Map(beforeKeys.map((k, i) => [k, before[i]!]));
  const afterBy = new Map(afterKeys.map((k, i) => [k, after[i]!]));
  return {
    added: afterKeys.filter((k) => !beforeBy.has(k)),
    removed: beforeKeys.filter((k) => !afterBy.has(k)),
    changed: afterKeys.filter((k) => {
      const b = beforeBy.get(k);
      return (
        b !== undefined &&
        JSON.stringify(normalize(b.value)) !== JSON.stringify(afterBy.get(k)!.value)
      );
    }),
  };
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
    const label = typeof s.label === 'string' ? s.label : undefined;
    // `{ type: "state", key }` is an accepted spelling of `{ state: key }`; the rest
    // of the format discriminates by which key is present, so it normalizes to that.
    if (s.type === 'state' && s.state === undefined) {
      if (typeof s.key !== 'string' || !s.key.trim()) {
        fail(index, '"type": "state" needs "key" naming a declared state key.', label);
      }
      s.state = s.key;
    }
    const kinds = ['command', 'eval', 'resize', 'state'].filter((k) => s[k] !== undefined);
    if (kinds.length !== 1) {
      fail(
        index,
        `a step carries exactly one of "command", "eval", "resize", "state" — found ${kinds.length}.`,
        label,
      );
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
        fail(index, '"resize" must be [width, height].', label);
      }
      const width = Number(size[0]);
      const height = Number(size[1]);
      if (!(width > 0) || !(height > 0)) {
        fail(index, '"resize" must be [width, height] with positive numbers.', label);
      }
      // A resize is harness setup, never a measurement — recording the window
      // acknowledgment would make every baseline row after it shift on a rename.
      return {
        ...base,
        kind: 'resize',
        width,
        height,
        label: label ?? `#${index} resize`,
        record: false,
      };
    }
    if (s.state !== undefined) {
      if (typeof s.state !== 'string' || !s.state.trim()) {
        fail(index, '"state" must name a key declared in defineApp({ state }).', label);
      }
      return {
        ...base,
        kind: 'state',
        stateKey: s.state,
        label: label ?? `#${index} state ${s.state}`,
        record: s.record !== false,
      };
    }
    if (s.eval !== undefined) {
      if (typeof s.eval !== 'string' || !s.eval.trim()) {
        fail(index, '"eval" must be an expression string.', label);
      }
      return {
        ...base,
        kind: 'eval',
        expression: s.eval,
        label: label ?? `#${index} eval`,
        record: s.record !== false,
      };
    }
    if (typeof s.command !== 'string' || !s.command.trim()) {
      fail(index, '"command" must be a command name string.', label);
    }
    if (s.params !== undefined && (s.params === null || typeof s.params !== 'object')) {
      fail(index, '"params" must be an object.', label);
    }
    return {
      ...base,
      kind: 'command',
      command: s.command,
      params: (s.params as Record<string, unknown>) ?? {},
      label: label ?? `#${index} ${s.command}`,
      record: s.record !== false,
    };
  });
  return {
    baselinePath: typeof doc.baseline === 'string' ? doc.baseline : defaultBaselinePath(scriptPath),
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
  if (step.kind === 'state') {
    return await invoke<unknown>(`yaar://windows/${wid}`, {
      action: 'app_query',
      stateKey: step.stateKey,
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
  /** Rows this run recorded that the baseline did not hold, by label. */
  added?: string[];
  /** Rows the baseline held that this run did not record, by label. */
  removed?: string[];
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
    throw new AppCommandError(
      `${stale}\nA regression run against a stale preview measures the wrong build.`,
    );
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
    let stepError: string | undefined;
    try {
      value = await executeStep(wid, step);
    } catch (err) {
      // Recorded, not thrown: "this step now errors" is a comparable finding, and
      // later groups are self-contained enough to still be worth measuring.
      stepError = errMsg(err);
      value = { error: stepError };
    }
    if (!step.record) {
      // A setup step's failure is invisible in the baseline by construction, so it
      // stops the run instead of being swallowed: every later row would measure
      // state the fixture never built, and rows that agree with the baseline
      // anyway are worse than no rows at all.
      if (stepError !== undefined) {
        throw new AppCommandError(
          `Script step ${step.index} (${step.label}) has "record": false and failed: ${stepError}\n` +
            'A setup step must succeed — fix it, or drop "record": false so the failure is ' +
            'recorded as a comparable row and the run continues.',
        );
      }
      continue;
    }
    // A step that threw while naming `pick` paths would otherwise record a row of
    // "<missing>" that says nothing about why. The error rides along so the diff's
    // `actual` names the cause.
    const projected = step.pick
      ? {
          ...Object.fromEntries(step.pick.map((p) => [p, pickPath(value, p)])),
          ...(stepError !== undefined ? { error: stepError } : {}),
        }
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

  // Updating comes before the alignment check on purpose. Re-capture is precisely
  // what a caller does after editing the script, so refusing it on the grounds that
  // the script was edited leaves no way forward at all. The delta is reported by
  // label instead, which is the part that carries the review: `added` and `removed`
  // are the script edit, `changed` is the behavior that moved under it.
  if (opts.update) {
    const delta = diffRows(expectedRows, rows);
    await writeBaseline();
    const restructured = delta.added.length > 0 || delta.removed.length > 0;
    return {
      mode: 'updated',
      ...summary,
      ...(delta.changed.length > 0 ? { changed: delta.changed } : {}),
      ...(delta.added.length > 0 ? { added: delta.added } : {}),
      ...(delta.removed.length > 0 ? { removed: delta.removed } : {}),
      note:
        delta.changed.length === 0 && !restructured
          ? 'Baseline rewritten; no row differed from the previous baseline.'
          : 'Baseline rewritten — these rows now define expected behavior. "changed" is a row ' +
            'whose value moved and should be a change you meant; "added" and "removed" are the ' +
            "script's own steps arriving and leaving, and are not evidence about behavior.",
    };
  }

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
    const delta = diffRows(expectedRows, rows);
    return {
      mode: 'compared',
      ...summary,
      pass: false,
      ...(delta.added.length > 0 ? { added: delta.added } : {}),
      ...(delta.removed.length > 0 ? { removed: delta.removed } : {}),
      structureMismatch:
        `${misaligned}. The script changed since the baseline was captured — "added" and ` +
        '"removed" name which rows. Verify current behavior on a build you trust, then re-run ' +
        `this same call with update: true to rewrite ${script.baselinePath}.`,
    };
  }

  const failures: ScriptFailure[] = [];
  rows.forEach((row, i) => {
    const expected = expectedRows[i];
    if (!expected) return;
    const want = JSON.stringify(normalize(expected.value));
    const got = JSON.stringify(row.value);
    if (want === got) return;
    failures.push({
      step: row.label,
      ...(row.group ? { group: row.group } : {}),
      expected: reportValue(normalize(expected.value)),
      actual: reportValue(row.value),
    });
  });

  const shown = failures.slice(0, MAX_REPORTED_FAILURES);
  return {
    mode: 'compared',
    ...summary,
    pass: failures.length === 0,
    ...(shown.length > 0 ? { failures: shown } : {}),
    ...(failures.length > shown.length ? { failuresOmitted: failures.length - shown.length } : {}),
  };
}
