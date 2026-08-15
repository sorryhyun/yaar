export {};
import { AppCommandError, defineAppCommand } from '@bundled/yaar';
import { activeProject, files } from '../core';
import { grep, readFileContent, noteWorkerToolCall, runWorkerTask } from '../services';

// ── Worker ─────────────────────────────────────────────────────────
// Two audiences, one file. `workerTask` is the app agent's door — the one
// command that appears in the manifest, so the concierge can delegate survey
// work instead of spending its own turns on reads. The `persona:*` entries are
// the handler halves of the tools the worker sub-agent is spawned with
// (services/worker.ts declares the other halves — the names and the descriptions
// the worker reads); their prefix hides them from the app agent's manifest, so
// the concierge never reads a script meant for the worker.
//
// `personaId` is stamped by the server rather than written by the model. All
// three are read-only against the active project, which is exactly the reach the
// worker is promised: it sees what devtools shows it, and nothing else.
//
// Each handler reports through `noteWorkerToolCall` — that is both the tool-call
// line in the panel transcript and the watchdog's sign of life for a turn that
// is calling tools instead of emitting text frames.

/** Refused as a string the worker can act on, not thrown: a missing project is a
 * normal state mid-conversation (the user closed it), and an error would read as
 * the tool being broken rather than the project being gone. */
const NO_PROJECT = 'No project is active in Dev Tools right now. Say so and stop.';

export const workerCommands = {
  workerTask: defineAppCommand({
    description:
      'Delegate one task to the worker — a sonnet-tier sub-agent that explores the active ' +
      'project with its own read-only tools (list files, read file, grep) and reports back. ' +
      'Use it for survey and lookup work you would otherwise spend many read commands on ' +
      '("map this codebase", "find every use of X", "check these files for Y"); it cannot ' +
      'edit, compile, or deploy. Blocks until the answer, so pass timeoutMs (120000 is a ' +
      'sane default; max 180000). A task that outlives your timeout keeps running — the ' +
      'answer lands in the "worker" state key when its status returns to idle, so query ' +
      'that instead of re-sending. The worker keeps its memory across tasks; follow-ups ' +
      'like "now check the other file" work. One task at a time — busy is a refusal, not ' +
      'a queue.',
    params: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task, self-contained — the worker sees none of your context.',
        },
      },
      required: ['task'],
    },
    replay: 'never',
    run: async (p) => {
      const outcome = await runWorkerTask(String(p.task));
      if (outcome.error) {
        throw new AppCommandError(
          outcome.answer
            ? `${outcome.error} Partial answer before it ended:\n${outcome.answer}`
            : outcome.error,
        );
      }
      return { answer: outcome.answer ?? '' };
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
