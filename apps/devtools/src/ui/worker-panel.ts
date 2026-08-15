export {};
import { createSignal, createEffect, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import {
  workerStatus,
  workerEntries,
  workerDraft,
  workerThinking,
  startWorkerTask,
  interruptWorker,
  resetWorker,
  type WorkerEntry,
} from '../services';
import { activeProject } from '../core';

// The worker tab: a task box and a transcript over the worker sub-agent
// (services/worker.ts owns every signal here; this component only renders them
// and forwards clicks). Deliberately bare — the panel is a window onto one
// conversation, not a chat product.

function statusDot(): string {
  const s = workerStatus();
  if (s === 'running' || s === 'spawning') return 'y-dot y-dot-accent y-dot-pulse';
  if (s === 'idle') return 'y-dot y-dot-ok';
  if (s === 'error') return 'y-dot y-dot-err';
  return 'y-dot';
}

function statusLabel(): string {
  const s = workerStatus();
  if (s === 'offline') return 'not spawned';
  if (s === 'spawning') return 'spawning…';
  if (s === 'running') return 'working…';
  return s;
}

function entryClass(entry: WorkerEntry): string {
  return `worker-entry worker-entry-${entry.kind}`;
}

export function WorkerPanel() {
  const [task, setTask] = createSignal('');
  let listEl: HTMLDivElement | undefined;

  const busy = () => workerStatus() === 'running' || workerStatus() === 'spawning';

  function submit(): void {
    const text = task().trim();
    if (!text || busy()) return;
    setTask('');
    // Fire and forget: the transcript signals are the only feedback this panel
    // has ever rendered, and they update from the stream either way.
    void startWorkerTask(text);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  // Follow the tail: a transcript whose newest line is below the fold reads as
  // a worker that stopped. Driven by the signals the transcript renders from.
  createEffect(() => {
    workerEntries();
    workerDraft();
    workerThinking();
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  });

  return html`
    <div class="worker-panel">
      <div class="worker-status">
        <span class=${statusDot}></span>
        <span class="y-text-xs y-text-muted">${statusLabel}</span>
        <${Show} when=${() => workerStatus() === 'running'}>
          <button class="sidebar-tab-action y-text-xs" onClick=${() => void interruptWorker()}>
            Stop
          </button>
        <//>
        <${Show} when=${() => !busy() && workerEntries().length > 0}>
          <button class="sidebar-tab-action y-text-xs" onClick=${() => void resetWorker()}>
            Reset
          </button>
        <//>
      </div>
      <div class="worker-list y-scroll" ref=${(el: HTMLDivElement) => (listEl = el)}>
        <${Show} when=${() => workerEntries().length === 0 && !busy()}>
          <div class="worker-empty y-text-xs y-text-muted">
            A sonnet sub-agent that explores the active project with read-only tools (list, read,
            grep) and reports back. Give it a task below — follow-ups share its memory.
          </div>
        <//>
        <${For} each=${workerEntries}>
          ${(entry: WorkerEntry) => html`
            <div class=${entryClass(entry)}>
              <${Show} when=${() => entry.kind === 'tool'} fallback=${() => entry.text}>
                <span class="worker-tool-line">⚙ ${entry.text}</span>
              <//>
            </div>
          `}
        <//>
        <${Show} when=${() => workerThinking().trim().length > 0 && busy()}>
          <details class="worker-thinking y-text-xs">
            <summary class="y-text-muted">thinking…</summary>
            <div>${workerThinking}</div>
          </details>
        <//>
        <${Show} when=${() => workerDraft().length > 0}>
          <div class="worker-entry worker-entry-answer worker-entry-live">${workerDraft}</div>
        <//>
      </div>
      <div class="worker-input">
        <textarea
          class="y-input worker-task-input"
          rows="3"
          placeholder=${() => (activeProject() ? 'Task for the worker…' : 'Open a project first')}
          value=${task}
          disabled=${() => !activeProject()}
          onInput=${(e: InputEvent) => setTask((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown=${onKeyDown}
        ></textarea>
        <button
          class="y-btn y-btn-primary y-text-xs"
          disabled=${() => busy() || !activeProject() || task().trim().length === 0}
          onClick=${submit}
        >
          ${() => (busy() ? 'Working…' : 'Run')}
        </button>
      </div>
    </div>
  `;
}
