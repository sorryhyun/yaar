export {};
import { createSignal, createEffect, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import {
  workerEntries,
  workerSlots,
  workerCap,
  setWorkerCap,
  startWorkerTask,
  interruptWorker,
  resetWorker,
  MAX_WORKERS,
  type WorkerEntry,
  type WorkerSlot,
  type WorkerStatus,
} from '../services';
import { activeProject } from '../core';

// The worker tab: a task box, one status chip per worker within the cap, and the
// shared transcript with each line tagged by the worker that wrote it
// (services/worker.ts owns every signal here; this component only renders them
// and forwards clicks).

function dotClass(s: WorkerStatus): string {
  if (s === 'running' || s === 'spawning') return 'y-dot y-dot-accent y-dot-pulse';
  if (s === 'idle') return 'y-dot y-dot-ok';
  if (s === 'error') return 'y-dot y-dot-err';
  return 'y-dot';
}

function statusLabel(s: WorkerStatus): string {
  if (s === 'offline') return 'not spawned';
  if (s === 'spawning') return 'spawning…';
  if (s === 'running') return 'working…';
  return s;
}

function entryClass(entry: WorkerEntry): string {
  return `worker-entry worker-entry-${entry.kind}`;
}

function labelOf(id: string): string {
  return workerSlots.find((s) => s.id === id)?.label ?? id;
}

export function WorkerPanel() {
  const [task, setTask] = createSignal('');
  let listEl: HTMLDivElement | undefined;

  const enabled = () => workerSlots.slice(0, workerCap());
  const busy = (s: WorkerSlot) => s.status() === 'running' || s.status() === 'spawning';
  const anyBusy = () => workerSlots.some(busy);
  const allBusy = () => enabled().every(busy);
  const multi = () => workerCap() > 1;

  function submit(): void {
    const text = task().trim();
    if (!text || allBusy()) return;
    setTask('');
    // Fire and forget: the transcript signals update from the stream either way.
    void startWorkerTask(text);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  // Follow the tail: a transcript whose newest line is below the fold reads as a
  // worker that stopped.
  createEffect(() => {
    workerEntries();
    for (const s of workerSlots) {
      s.draft();
      s.thinking();
    }
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  });

  const caps = Array.from({ length: MAX_WORKERS }, (_, i) => i + 1);

  return html`
    <div class="worker-panel">
      <div class="y-toolbar y-toolbar-dense worker-status">
        <${For} each=${enabled}>
          ${(slot: WorkerSlot) => html`
            <span class="worker-chip" title=${() => `${slot.id}: ${statusLabel(slot.status())}`}>
              <span class=${() => dotClass(slot.status())}></span>
              <span class="y-text-xs">${() => (multi() ? slot.label : '')}</span>
              <span class="y-text-xs y-text-muted">
                ${() =>
                  slot.activeTask() ? `#${slot.activeTask()!.id}` : statusLabel(slot.status())}
              </span>
              <${Show} when=${() => slot.status() === 'running'}>
                <button
                  class="sidebar-tab-action y-text-xs"
                  title=${`Stop ${slot.id}`}
                  onClick=${() => void interruptWorker({ worker: slot.id })}
                >
                  Stop
                </button>
              <//>
            </span>
          `}
        <//>
        <span class="worker-status-spacer"></span>
        <select
          class="y-select worker-cap"
          title="How many workers may run at once"
          onChange=${(e: Event) =>
            void setWorkerCap(Number((e.currentTarget as HTMLSelectElement).value))}
        >
          <${For} each=${caps}>
            ${(n: number) => html`<option value=${String(n)} selected=${() => workerCap() === n}>
                ${n} parallel
              </option>`}
          <//>
        </select>
        <${Show} when=${() => !anyBusy() && workerEntries().length > 0}>
          <button class="sidebar-tab-action y-text-xs" onClick=${() => void resetWorker()}>
            Reset
          </button>
        <//>
      </div>
      <div class="worker-list y-scroll" ref=${(el: HTMLDivElement) => (listEl = el)}>
        <${Show} when=${() => workerEntries().length === 0 && !anyBusy()}>
          <div class="worker-empty y-text-xs y-text-muted">
            Sonnet sub-agents that explore the active project with read-only tools (list, read,
            grep) and report back — several can run at once. They can propose edits but never
            apply them; the agent you are talking to accepts or rejects those, one at a time.
            Give a task below — follow-ups share a worker's memory.
          </div>
        <//>
        <${For} each=${workerEntries}>
          ${(entry: WorkerEntry) => html`
            <div class=${entryClass(entry)}>
              <${Show} when=${() => multi() && entry.kind !== 'tool'}>
                <div class="worker-report-tag">${labelOf(entry.worker)}</div>
              <//>
              <${Show} when=${() => entry.kind === 'report'}>
                <div class="worker-report-tag">interim report</div>
              <//>
              <${Show} when=${() => entry.kind === 'edit-request'}>
                <div class="worker-report-tag">proposed edit · awaiting the agent</div>
              <//>
              <${Show} when=${() => entry.kind === 'tool'} fallback=${() => entry.text}>
                <span class="worker-tool-line"
                  >${() => (multi() ? `${labelOf(entry.worker)} ` : '')}⚙ ${entry.text}</span
                >
              <//>
            </div>
          `}
        <//>
        <${For} each=${() => workerSlots}>
          ${(slot: WorkerSlot) => html`
            <${Show} when=${() => slot.thinking().trim().length > 0 && busy(slot)}>
              <details class="worker-thinking y-text-xs">
                <summary class="y-text-muted">
                  ${() => (multi() ? `${slot.label} ` : '')}thinking…
                </summary>
                <div>${slot.thinking}</div>
              </details>
            <//>
            <${Show} when=${() => slot.draft().length > 0}>
              <div class="worker-entry worker-entry-answer worker-entry-live">
                <${Show} when=${multi}>
                  <div class="worker-report-tag">${slot.label} · writing</div>
                <//>
                ${slot.draft}
              </div>
            <//>
          `}
        <//>
      </div>
      <div class="worker-input">
        <textarea
          class="y-input worker-task-input"
          rows="3"
          placeholder=${() => (activeProject() ? 'Task for a worker…' : 'Open a project first')}
          value=${task}
          disabled=${() => !activeProject()}
          onInput=${(e: InputEvent) => setTask((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown=${onKeyDown}
        ></textarea>
        <button
          class="y-btn y-btn-primary y-text-xs"
          disabled=${() => allBusy() || !activeProject() || task().trim().length === 0}
          onClick=${submit}
        >
          ${() => (allBusy() ? 'All workers busy…' : 'Run')}
        </button>
      </div>
    </div>
  `;
}
