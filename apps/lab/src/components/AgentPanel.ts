import { createEffect, createSignal, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { formatClock } from '@bundled/yaar';
import { agentRuns, clearAgentRuns, newestId, setMainView, MAX_ENTRIES } from '../state/agent-runs';
import { OutputView } from './OutputView';
import type { AgentRun } from '../types';

/**
 * The agent run log — one of the two main views, shown instead of the notebook.
 * Console-style: newest entry last, scrolled to whenever the view is entered or a
 * run lands. Each entry reuses OutputView, so a table renders as a table and a
 * chart as a chart — exactly what the cell would have shown.
 */

const [expanded, setExpanded] = createSignal<string[]>([]);
const isExpanded = (id: string) => expanded().includes(id);

function toggleSource(id: string): void {
  setExpanded(isExpanded(id) ? expanded().filter((x) => x !== id) : [...expanded(), id]);
}

function peek(source: string): string {
  const line = (source || '').split('\n').find((l) => l.trim()) || '(empty)';
  return line.length > 90 ? line.slice(0, 90) + '…' : line;
}

function RunEntry(props: { run: AgentRun }) {
  const run = () => props.run;
  return html`
    <div
      class=${() =>
        'lab-run-entry' +
        (run().ok ? '' : ' lab-run-bad') +
        (newestId() === run().id ? ' lab-run-new' : '')}
    >
      <div class="lab-run-head">
        <span class=${() => 'y-dot ' + (run().ok ? 'y-dot-ok' : 'y-dot-err')}></span>
        <span class="lab-run-kind">${() => run().kind}${() => (run().cellId ? ' · ' + run().cellId : '')}</span>
        <span class="lab-note">${() => formatClock(run().at)}</span>
        <span class="lab-note">${() => run().durationMs + ' ms'}</span>
        <span class="lab-run-peek">${() => peek(run().source)}</span>
        <span class="lab-spacer"></span>
        <button class="lab-mini" onClick=${() => toggleSource(run().id)}>
          ${() => (isExpanded(run().id) ? '▾ source' : '▸ source')}
        </button>
      </div>
      <${Show} when=${() => isExpanded(run().id)}>
        <pre class="lab-run-src">${() => run().source}</pre>
      <//>
      <${Show} when=${() => run().output}>
        <${OutputView} output=${() => run().output} />
      <//>
      <${Show} when=${() => !run().output && !run().ok}>
        <pre class="lab-pre lab-err lab-run-src">${() => run().error || 'failed'}</pre>
      <//>
      <${Show} when=${() => run().savedTo || run().saveError || run().truncated}>
        <div class="lab-run-note">
          ${() => (run().savedTo ? 'saved to ' + run().savedTo + '  ' : '')}
          ${() => (run().saveError ? 'save failed: ' + run().saveError + '  ' : '')}
          ${() => (run().truncated ? 'agent result was truncated' : '')}
        </div>
      <//>
    </div>`;
}

export function AgentPanel() {
  let body: HTMLDivElement | undefined;
  // Console behaviour: follow the tail whenever a new entry lands. Twice, because a
  // table or a chart canvas finishes laying out after the microtask.
  createEffect(() => {
    agentRuns().length;
    const tail = () => {
      if (body) body.scrollTop = body.scrollHeight;
    };
    queueMicrotask(tail);
    setTimeout(tail, 120);
  });

  return html`
    <div class="lab-agent">
      <div class="lab-agent-head">
        <span class="lab-agent-title">Agent runs</span>
        <span class="lab-note">${() => agentRuns().length + ' / ' + MAX_ENTRIES}</span>
        <span class="lab-spacer"></span>
        <button class="lab-mini" title="Clear the log" onClick=${() => clearAgentRuns()}>Clear</button>
        <button class="lab-mini" title="Back to the notebook" onClick=${() => setMainView('notebook')}>Notebook →</button>
      </div>
      <div class="lab-agent-body" ref=${(el: HTMLDivElement) => (body = el)}>
        <${Show}
          when=${() => agentRuns().length > 0}
          fallback=${() =>
            html`<div class="lab-agent-empty">
              No protocol runs yet. Anything an agent runs — runCode, runCell, runAll — appears here.
            </div>`}
        >
          <${For} each=${agentRuns}>${(r: AgentRun) => html`<${RunEntry} run=${r} />`}<//>
        <//>
      </div>
    </div>`;
}
