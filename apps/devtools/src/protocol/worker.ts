export {};
import { AppCommandError, defineAppCommand } from '@bundled/yaar';
import { activeProject, files } from '../core';
import {
  grep,
  readFileContent,
  addWorkerReport,
  interruptWorker,
  noteWorkerToolCall,
  startWorkerTask,
  waitForWorker,
} from '../services';

// Two audiences, one file. `workerTask`/`workerWait` are the app agent's door —
// the two commands that appear in the manifest, so the concierge can delegate
// survey work instead of spending its own turns on reads, and collect it when
// it has run out of work to do meanwhile. The `persona:*` entries are
// the handler halves of the tools the worker sub-agent is spawned with
// (services/worker.ts declares the other halves — the names and the descriptions
// the worker reads); their prefix hides them from the app agent's manifest, so
// the concierge never reads a script meant for the worker.
//
// `personaId` is stamped by the server rather than written by the model. The
// three lookup tools are read-only against the active project, which is exactly
// the reach the worker is promised: it sees what devtools shows it, and nothing
// else. `report` is the one that goes the other way — the worker talking back
// mid-turn — and it is a tool like any other here rather than a new capability,
// which is what keeps its audience to this iframe and the one agent behind it.
//
// Each handler reports through `noteWorkerToolCall` (`report` through
// `addWorkerReport`) — that is both the line in the panel transcript and the
// watchdog's sign of life for a turn that is calling tools instead of emitting
// text frames.

/** Refused as a string the worker can act on, not thrown: a missing project is a
 * normal state mid-conversation (the user closed it), and an error would read as
 * the tool being broken rather than the project being gone. */
const NO_PROJECT = 'No project is active in Dev Tools right now. Say so and stop.';

export const workerCommands = {
  workerTask: defineAppCommand({
    description:
      'Start one task on the worker — a sonnet-tier sub-agent that explores the active ' +
      'project with its own read-only tools (list files, read file, grep) and reports back. ' +
      'Use it for survey and lookup work you would otherwise spend many read commands on ' +
      '("map this codebase", "find every use of X", "check these files for Y"); it cannot ' +
      'edit, compile, or deploy. RETURNS IMMEDIATELY with a taskId — it does not wait for ' +
      'the answer, so spend the time on your own work (read, edit, compile). You are then ' +
      'WOKEN with the answer when it lands (an <app:event channel="worker"> message with ' +
      'kind "result"), so ending your turn is safe and is the right move when you have ' +
      'nothing else to do — workerWait is for when you want to block instead, and the ' +
      '"worker" state key for a plain look. The worker posts interim findings as it goes; ' +
      'they arrive with the result, and an urgent one wakes you early as kind "report" — ' +
      'that is your cue to re-scope or call workerInterrupt, not to assume the task is done. ' +
      'The worker keeps its memory across tasks; follow-ups like "now check the other file" ' +
      'work, and `fresh` is how you opt out of that. One task at a time — starting another ' +
      'while one runs is a refusal, not a queue.',
    params: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task, self-contained — the worker sees none of your context.',
        },
        fresh: {
          type: 'boolean',
          description:
            'Retire the worker first, so this task starts with no memory of earlier ones. ' +
            'Use when its context has gone stale or an earlier answer was wrong and you do ' +
            'not want this one built on it. Costs a respawn; the default (false) is right ' +
            'for a follow-up.',
        },
      },
      required: ['task'],
    },
    replay: 'never',
    run: async (p) => {
      // `wakeAgent` is what separates this call from the same task typed into the
      // Worker panel: the agent asked, so the agent is woken when it settles.
      const started = await startWorkerTask(String(p.task), {
        wakeAgent: true,
        ...(p.fresh === true ? { fresh: true } : {}),
      });
      if (started.error) throw new AppCommandError(started.error);
      return {
        taskId: started.taskId,
        status: 'running',
        collect:
          `You will be woken with the answer (channel "worker", taskId ${started.taskId}). ` +
          'To block for it instead, call workerWait.',
      };
    },
  }),
  workerInterrupt: defineAppCommand({
    description:
      'Stop the task the worker is running and take whatever it has produced so far — its ' +
      'partial answer and every interim report. Use it when a report or a state-key read ' +
      'shows the task was mis-scoped: a wrong path list, a pattern that matches nothing, an ' +
      'instruction resting on something untrue. Stopping and re-sending a corrected task ' +
      'beats waiting out a turn you already know is wrong. The worker keeps its memory, so ' +
      'the retry can say "same as before, but under src/ this time".',
    params: { type: 'object', properties: {} },
    replay: 'never',
    run: async () => interruptWorker(),
  }),
  workerWait: defineAppCommand({
    description:
      'Collect a task started by workerTask: returns its answer, or `done: false` if it is ' +
      'still working. Blocks up to waitMs (default 60000, max 170000) — always pass a ' +
      'timeoutMs at least 10s larger than waitMs, or the platform kills the call before the ' +
      'wait ends. Timing out is cheap: the task keeps running and calling again resumes the ' +
      'wait, so a long survey can be collected in slices. Omit taskId to ask about the task ' +
      'in flight (or the last one to finish). Never re-send a task to "retry" a wait. ' +
      '`reports` carries the interim findings the worker posted, and comes back on a timeout ' +
      'too — read them before deciding whether to keep waiting or to workerInterrupt. A ' +
      'settled task ALWAYS carries an `answer` or an `error`: an `error` saying the worker ' +
      'produced no answer means nothing was learned, never "nothing was found".',
    params: {
      type: 'object',
      properties: {
        taskId: {
          type: 'number',
          description: 'The id workerTask returned. Omit for the current or most recent task.',
        },
        waitMs: {
          type: 'number',
          description: 'How long to block before reporting back. Default 60000, max 170000.',
        },
      },
    },
    replay: 'never',
    run: async (p) => {
      const result = await waitForWorker({
        ...(p.taskId != null ? { taskId: Number(p.taskId) } : {}),
        ...(p.waitMs != null ? { waitMs: Number(p.waitMs) } : {}),
      });
      // Reported, not thrown, even for `error`: a partial answer, a still-running
      // task and a failure are all things the caller acts on differently, and an
      // AppCommandError flattens the three into one refusal.
      return result;
    },
  }),
  'persona:list_files': defineAppCommand({
    description:
      "Called by the worker sub-agent's list_files tool: the active project's file listing.",
    params: {
      type: 'object',
      properties: { personaId: { type: 'string' } },
      required: ['personaId'],
    },
    replay: 'never',
    run: async () => {
      noteWorkerToolCall('list_files');
      const proj = activeProject();
      if (!proj) return NO_PROJECT;
      const lines = files()
        .filter((f) => !f.isDirectory)
        .map((f) =>
          f.lines !== undefined
            ? `${f.path} (${f.lines} lines)`
            : `${f.path} (${f.bytes ?? '?'} bytes, binary)`,
        );
      return `Project "${proj.name}" — ${lines.length} files:\n${lines.join('\n')}`;
    },
  }),
  'persona:read_file': defineAppCommand({
    description:
      "Called by the worker sub-agent's read_file tool: one project file, line-numbered.",
    params: {
      type: 'object',
      properties: {
        personaId: { type: 'string' },
        path: { type: 'string' },
        start_line: { type: 'number' },
        end_line: { type: 'number' },
      },
      required: ['personaId', 'path'],
    },
    replay: 'never',
    run: async (p) => {
      const path = String(p.path);
      noteWorkerToolCall(`read_file ${path}`);
      if (!activeProject()) return NO_PROJECT;
      const result = await readFileContent(path, {
        startLine: p.start_line != null ? Number(p.start_line) : undefined,
        endLine: p.end_line != null ? Number(p.end_line) : undefined,
        lineNum: true,
      });
      return result.content;
    },
  }),
  'persona:report': defineAppCommand({
    description:
      "Called by the worker sub-agent's report tool: one interim finding, delivered mid-turn.",
    params: {
      type: 'object',
      properties: {
        personaId: { type: 'string' },
        finding: { type: 'string' },
        notify: { type: 'boolean' },
      },
      required: ['personaId', 'finding'],
    },
    replay: 'never',
    // The only handler here that does not touch the project: a report is the
    // worker talking, not the worker looking. No `noteWorkerToolCall` either —
    // `addWorkerReport` files its own transcript line and feeds the watchdog,
    // and a "⚙ report" line above every finding would be noise.
    run: async (p) => addWorkerReport(String(p.finding ?? ''), p.notify === true),
  }),
  'persona:grep': defineAppCommand({
    description: "Called by the worker sub-agent's grep tool: regex search across the project.",
    params: {
      type: 'object',
      properties: {
        personaId: { type: 'string' },
        pattern: { type: 'string' },
        glob: { type: 'string' },
      },
      required: ['personaId', 'pattern'],
    },
    replay: 'never',
    run: async (p) => {
      const pattern = String(p.pattern);
      noteWorkerToolCall(`grep /${pattern}/${p.glob ? ` in ${p.glob}` : ''}`);
      if (!activeProject()) return NO_PROJECT;
      const result = await grep(pattern, p.glob ? String(p.glob) : undefined);
      if (result.matches.length === 0) return 'No matches found.';
      const body = result.matches.map((m) => `${m.file}:${m.line}│${m.content}`).join('\n');
      return result.truncated ? `${body}\n(results truncated)` : body;
    },
  }),
};
