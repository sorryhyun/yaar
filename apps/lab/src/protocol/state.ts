import { current, notebooks } from '../state/signals';
import { lastRun, timeoutMs } from '../state/run';
import { agentRunsForState } from '../state/agent-runs';
import { cellsForState } from './shape';

export const labState = {
  notebooks: {
    description: 'Saved notebooks: { id, title, updatedAt, cellCount }[]. Newest first.',
    get: () => notebooks(),
  },
  currentNotebook: {
    description:
      'The open notebook: { id, title, cells: [{ id, type, source, hasOutput }] }. Cell OUTPUTS are deliberately excluded (they are large) — read a result with runCode or the summary in lastRun.',
    get: () => {
      const nb = current();
      if (!nb) return null;
      return {
        id: nb.id,
        title: nb.title,
        updatedAt: nb.updatedAt,
        cells: cellsForState(nb.cells),
      };
    },
  },
  lastRun: {
    description: 'The most recent cell execution: { cellId, ok, summary, durationMs, at }.',
    get: () => lastRun(),
  },
  agentRuns: {
    description:
      'The Agent runs panel, oldest first, last 50: { id, at, kind: runCode|runCell|runAll, cellId, ok, durationMs, summary, savedTo, error }[]. Every protocol-initiated execution is logged here and rendered in the window; sources and result payloads stay in the UI and are deliberately not exposed.',
    get: () => agentRunsForState(),
  },
  kernel: {
    description: 'Kernel settings: { defaultTimeoutMs }.',
    get: () => ({ defaultTimeoutMs: timeoutMs() }),
  },
};
