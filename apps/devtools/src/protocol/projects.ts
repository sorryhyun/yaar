import { AppCommandError, defineAppCommand } from '@bundled/yaar';
import { activeProject, files } from '../core';
import { createProject, openProject, deleteProject, cloneApp, readAppSource } from '../services';
import { groupByFile, markdownOutline, summarizeFiles } from '../lib';

export const projectCommands = {
  createProject: defineAppCommand({
    description:
      'Create a new project and open it. Scaffolds a working app — one `export default ' +
      'defineApp({...})` with a state key and a Zod-validated command — plus styles.css and ' +
      'an app.json whose `appId` is derived from the name and is legal to deploy under. ' +
      'Returns { projectId, appId, project, files } — `files` being the new file paths.',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' },
      },
      required: ['name'],
    },
    replay: 'never',
    run: async (p) => {
      const { id, appId, previous } = await createProject(String(p.name));
      const proj = activeProject();
      return {
        projectId: id,
        appId,
        project: proj ? { id: proj.id, name: proj.name } : undefined,
        files: files().map((f) => f.path),
        ...(previous ? { previousProject: previous } : {}),
      };
    },
  }),
  openProject: defineAppCommand({
    description: 'Switch to an existing project',
    params: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    run: async (p) => {
      await openProject(String(p.id));
      const proj = activeProject();
      if (!proj) throw new AppCommandError('Project not found');
      return {
        project: { id: proj.id, name: proj.name },
        files: files().map((f) => f.path),
      };
    },
  }),
  deleteProject: defineAppCommand({
    description:
      'Permanently delete a project and its files. Not undoable. Deleting the active project ' +
      'reopens the one that was in front when it was created or cloned (else the last open ' +
      'tab); the result names it as `reopened`.',
    params: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        reopenPrevious: {
          type: 'boolean',
          description:
            'Default true. false: fall back to the last open tab instead of the project ' +
            'this one was made from.',
        },
      },
      required: ['id'],
    },
    replay: 'never',
    run: async (p) =>
      await deleteProject(String(p.id), { reopenPrevious: p.reopenPrevious !== false }),
  }),
  cloneApp: defineAppCommand({
    description:
      'Clone an installed app source into a new project and open it — to change it; ' +
      'readAppSource only reads it. The copy is a sandbox: ' +
      'editing it changes nothing about the live app until you deploy. Answers with a map ' +
      'to read from, not the contents: `appId` (from the cloned app.json — the id deploy ' +
      'expects); `size` (file, line and byte totals, plus the five largest files); `tree` ' +
      '(the same per directory, rolled up two levels); `protocol` — where each command and ' +
      'state key is declared, as { commands: { file: { name: line } }, state: … }, the way ' +
      'from a command name to its code; and `agentsMd` — the root AGENTS.md as { bytes, ' +
      'lines, outline: [{ heading, line, lines }] } (null when the app has none). Read a ' +
      'section with readFile({ path: "AGENTS.md", section }); `include` returns the full ' +
      'text or file list instead. `previousProject` is the project the clone replaced in ' +
      'front, which deleteProject on the clone reopens. When clones of the same app were ' +
      'already here, `existingClones` comes first, oldest first as { id, name, ' +
      'lastModified, version?, stale } — `stale` meaning their version is not the installed ' +
      'one. `reuse: true` reopens the newest non-stale one instead of cloning (`reused` says ' +
      'it did); its edits, if any, come with it.',
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App ID to clone' },
        reuse: {
          type: 'boolean',
          description:
            'Reopen the newest existing clone at the installed version, if there is one, ' +
            'rather than cloning again. Default false: a fresh copy of the live source.',
        },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['agentsMd', 'files'] },
          description:
            '"agentsMd": the whole AGENTS.md text in place of its outline. "files": every ' +
            'path with its size (what the `project` state also answers).',
        },
      },
      required: ['appId'],
    },
    replay: 'never',
    run: async (p) => {
      const include = new Set(Array.isArray(p.include) ? p.include.map(String) : []);
      const {
        id: projectId,
        appId,
        agentsMd,
        previous,
        existingClones,
        protocolSources,
        reused,
      } = await cloneApp(String(p.appId), { reuse: p.reuse === true });
      const proj = activeProject();
      const listing = files();
      const { size, tree } = summarizeFiles(listing);
      return {
        // First, so a pile of old clones is the first thing read, not the last.
        ...(existingClones.length > 0 ? { existingClones } : {}),
        ...(reused ? { reused } : {}),
        projectId,
        appId,
        project: proj ? { id: proj.id, name: proj.name } : undefined,
        ...(previous ? { previousProject: previous } : {}),
        size,
        tree,
        ...(protocolSources
          ? {
              protocol: {
                commands: groupByFile(protocolSources.commands),
                state: groupByFile(protocolSources.state),
              },
            }
          : {}),
        agentsMd:
          agentsMd === null
            ? null
            : include.has('agentsMd')
              ? agentsMd
              : {
                  bytes: new TextEncoder().encode(agentsMd).length,
                  lines: agentsMd.split('\n').length,
                  outline: markdownOutline(agentsMd),
                },
        ...(include.has('files')
          ? {
              files: listing.map((f) =>
                f.isDirectory
                  ? { path: f.path, isDirectory: true as const }
                  : {
                      path: f.path,
                      ...(f.lines !== undefined ? { lines: f.lines } : {}),
                      ...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
                    },
              ),
            }
          : {}),
      };
    },
  }),
  readAppSource: defineAppCommand({
    description:
      "Read an installed app's source without cloning it: no project is created and the " +
      'one in front stays in front. For looking at how another app does something; clone ' +
      'only to change it. Three forms, by which params are given: no `path`/`pattern` — the ' +
      'file list { path, lines } plus `protocol` (where each command and state key is ' +
      "declared, by file and line); `path` — that file's text, optionally a " +
      '`startLine`/`endLine` slice; `pattern` — regex hits { file, line, content } across ' +
      'its text files, narrowed by `glob`, capped at 200 (`total` counts the rest). Reads ' +
      'the installed copy, cached for a minute.',
    params: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'Installed app id, e.g. "storage".' },
        path: { type: 'string', description: 'App-relative file, e.g. "src/main.ts".' },
        startLine: { type: 'number', description: 'With `path`: first line (1-based).' },
        endLine: { type: 'number', description: 'With `path`: last line (inclusive).' },
        pattern: { type: 'string', description: 'Regex to search for (not with `path`).' },
        glob: { type: 'string', description: 'With `pattern`: file filter, e.g. "src/**/*.ts".' },
      },
      required: ['appId'],
    },
    replay: 'never',
    run: async (p) => {
      if (p.path !== undefined && p.pattern !== undefined) {
        throw new AppCommandError('Pass `path` or `pattern`, not both.');
      }
      const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
      return await readAppSource({
        appId: String(p.appId),
        ...(p.path !== undefined ? { path: String(p.path) } : {}),
        ...(num(p.startLine) !== undefined ? { startLine: num(p.startLine) } : {}),
        ...(num(p.endLine) !== undefined ? { endLine: num(p.endLine) } : {}),
        ...(p.pattern !== undefined ? { pattern: String(p.pattern) } : {}),
        ...(p.glob !== undefined ? { glob: String(p.glob) } : {}),
      });
    },
  }),
};
