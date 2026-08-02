import type { Cell } from '../types';

/**
 * Shaping helpers for the agent-facing surface. The rule this whole app is built
 * around: large data must never cross the protocol boundary, so state exposes
 * sources without outputs and runCode returns capped logs.
 */

const MAX_SOURCE_IN_STATE = 4000;
const MAX_AGENT_LOG_CHARS = 4000;

export function cellsForState(cells: Cell[]) {
  return cells.map((c) => ({
    id: c.id,
    type: c.type,
    source: c.source.length > MAX_SOURCE_IN_STATE ? c.source.slice(0, MAX_SOURCE_IN_STATE) + '\n…(truncated)' : c.source,
    hasOutput: !!c.output,
  }));
}

export function agentLogs(logs: { level: string; text: string }[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of logs || []) {
    const line = l.level === 'log' ? l.text : '[' + l.level + '] ' + l.text;
    if (used + line.length > MAX_AGENT_LOG_CHARS) {
      out.push('… ' + (logs.length - out.length) + ' more log lines omitted');
      break;
    }
    out.push(line);
    used += line.length;
  }
  return out;
}
