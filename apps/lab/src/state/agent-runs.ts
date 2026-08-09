import { createSignal } from '@bundled/solid-js';
import { uid } from './signals';
import { trimOutput } from '../lib/trim';
import type { AgentRun, CellOutput } from '../types';

/**
 * The agent run log — the answer to "an agent ran something and the window showed
 * nothing". Every execution that arrives over the app protocol lands here and is
 * drawn by components/AgentPanel.ts with the ordinary cell output renderer.
 *
 * The log is one of the two main views (`mainView`), not a panel stacked under the
 * notebook. A `runCode` has nowhere else to show itself, so it pulls the view over
 * (`focus: true`); a `runCell`/`runAll` renders into its cell in the notebook, so it
 * only bumps `unseen`, which badges the tab. Either way the user can switch back,
 * and a later run may pull it over again.
 *
 * Two caps, both deliberate: MAX_ENTRIES bounds the list, and each entry's payload
 * goes through `trimOutput` — the same pass that caps a notebook before it is
 * written to disk — so one enormous result cannot wedge the UI.
 */

const MAX_ENTRIES = 50;
const MAX_SOURCE_CHARS = 20000;

export type MainView = 'notebook' | 'agent';

const [agentRuns, setAgentRuns] = createSignal<AgentRun[]>([]);
const [mainView, setView] = createSignal<MainView>('notebook');
const [unseen, setUnseen] = createSignal(0);
const [newestId, setNewestId] = createSignal<string | null>(null);

export { agentRuns, mainView, unseen, newestId, MAX_ENTRIES };

/** Switch the main pane. Landing on the log clears the unread badge. */
export function setMainView(view: MainView): void {
  setView(view);
  if (view === 'agent') setUnseen(0);
}

export function clearAgentRuns(): void {
  setAgentRuns([]);
  setUnseen(0);
  setNewestId(null);
}

export interface AgentRunInput {
  kind: AgentRun['kind'];
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
  /** Switch the main pane to the log. For runs with no other place to appear. */
  focus?: boolean;
}

/**
 * Record one protocol-initiated run. `focus` brings the log to the front; without
 * it the Agent runs tab is badged instead. A silent run is the bug this module
 * exists to prevent.
 */
export function logAgentRun(input: AgentRunInput): AgentRun {
  const source =
    input.source.length > MAX_SOURCE_CHARS
      ? input.source.slice(0, MAX_SOURCE_CHARS) + '\n…(source truncated)'
      : input.source;
  const run: AgentRun = {
    ...input,
    id: uid('a'),
    at: Date.now(),
    source,
    output: trimOutput(input.output),
  };
  setAgentRuns([...agentRuns(), run].slice(-MAX_ENTRIES));
  setNewestId(run.id);
  if (input.focus) setMainView('agent');
  else if (mainView() !== 'agent') setUnseen(unseen() + 1);
  return run;
}

/** The compact, agent-facing projection — no sources, no rendered payloads. */
export function agentRunsForState() {
  return agentRuns().map((r) => ({
    id: r.id,
    at: r.at,
    kind: r.kind,
    cellId: r.cellId,
    ok: r.ok,
    durationMs: r.durationMs,
    summary: r.summary,
    savedTo: r.savedTo,
    error: r.error,
  }));
}
