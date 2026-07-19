export {};
import {
  app,
  invoke,
  describe,
  list,
  errMsg,
  wait,
  AppCommandError,
  defineCommand,
} from '@bundled/yaar';
import { bundledLibraries } from '@bundled/yaar-dev';
import {
  activeProject,
  projects,
  openFilePath,
  openFileContent,
  diagnostics,
  compileStatus,
  compileErrors,
  previewUrl,
  previewWindowId,
  setPreviewWindowId,
  files,
  bundledLibs,
  consoleLogs,
  createProject,
  openProject,
  deleteProject,
  openFile,
  writeFile,
  editFile,
  deleteFile,
  compile,
  typecheck,
  deploy,
  gitHistory,
  gitDiff,
  gitRestore,
  gitCheckpoint,
  cloneApp,
  clearConsoleLogs,
  grep,
  readFileContent,
  copyFile,
  staticProtocol,
  type EditSpec,
} from './project';
import { openPreview, readPreview } from './preview';
import { getStaticManifest, getRuntimeManifest, diffManifestNames } from './manifest';

const MIME_MAP: Record<string, string> = {
  ts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'application/javascript',
  jsx: 'application/javascript',
  json: 'application/json',
  html: 'text/html',
  css: 'text/css',
  md: 'text/markdown',
  txt: 'text/plain',
  svg: 'image/svg+xml',
};

function getMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_MAP[ext] || 'text/plain';
}


export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'devtools',
    name: 'Devtools',
    state: {
      project: {
        description:
          'Active project. Files come with their size: { path, lines, bytes } for text files, ' +
          '{ path, isDirectory: true } for directories.',
        handler: () => {
          const proj = activeProject();
          if (!proj) return null;
          return {
            ...proj,
            files: files().map((f) =>
              f.isDirectory
                ? { path: f.path, isDirectory: true as const }
                : {
                    path: f.path,
                    ...(f.lines !== undefined ? { lines: f.lines } : {}),
                    ...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
                  },
            ),
          };
        },
      },
      projects: {
        description: 'All projects',
        handler: () => [...projects()],
      },
      openFile: {
        description: 'Currently open file (with line numbers)',
        handler: () => {
          const path = openFilePath();
          if (!path) return null;
          const raw = openFileContent();
          const ext = path.split('.').pop() ?? '';
          if (raw == null) return { path, content: null, language: ext };
          const lines = raw.split('\n');
          const width = String(lines.length).length;
          const numbered = lines
            .map((line, i) => `${String(i + 1).padStart(width)}│${line}`)
            .join('\n');
          return {
            path,
            content: `── ${path} (${lines.length} lines) ──\n${numbered}`,
            language: ext,
          };
        },
      },
      diagnostics: {
        description: 'TypeScript errors/warnings',
        handler: () => [...diagnostics()],
      },
      compileStatus: {
        description: 'Compilation state',
        handler: () => compileStatus(),
      },
      compileErrors: {
        description: 'Compilation errors (if any)',
        handler: () => [...compileErrors()],
      },
      previewUrl: {
        description: 'URL of last successful compilation',
        handler: () => previewUrl(),
      },
      bundledLibraries: {
        description: 'Available @bundled/* import libraries',
        handler: () => [...bundledLibs()],
      },
      consoleLogs: {
        description:
          'Console output from the preview app, with connection state. `connected: false` means ' +
          'the buffer could not be read — an empty `logs` then says nothing about whether the ' +
          'app logged anything.',
        handler: async () => {
          // Pull the live console buffer straight from the preview window over
          // the app protocol. The preview runs as its own registered window
          // (where verb calls work), so its console-capture buffer is the
          // source of truth — the local signal is only a display cache updated
          // by the poll in project.ts.
          //
          // Every failure here used to collapse into the same empty array, so "no preview open",
          // "preview unreachable" and "app logged nothing" were indistinguishable — a reader had
          // no choice but to guess. Report which one it is.
          const wid = previewWindowId();
          if (!wid) {
            return {
              connected: false,
              reason: 'No preview window is open. Run the preview command first.',
              logs: [],
            };
          }
          try {
            const entries = await invoke(`yaar://windows/${wid}`, {
              action: 'app_query',
              stateKey: '__console',
            });
            if (!Array.isArray(entries)) {
              return {
                connected: false,
                reason: 'Preview window did not return a console buffer.',
                windowId: wid,
                logs: [...consoleLogs()],
              };
            }
            return { connected: true, windowId: wid, logs: entries };
          } catch (err) {
            return {
              connected: false,
              reason: `Preview console unreachable: ${errMsg(err)}`,
              windowId: wid,
              logs: [...consoleLogs()],
            };
          }
        },
      },
    },
    commands: {
      createProject: defineCommand({
        description: 'Create a new project',
        params: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Project name' },
          },
          required: ['name'],
        },
        handler: async (p) => {
          const id = await createProject(String(p.name));
          return { projectId: id };
        },
      }),
      openProject: defineCommand({
        description: 'Switch to an existing project',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        handler: async (p) => {
          await openProject(String(p.id));
          const proj = activeProject();
          if (!proj) throw new AppCommandError('Project not found');
          return {
            project: { id: proj.id, name: proj.name },
            files: files().map((f) => f.path),
          };
        },
      }),
      deleteProject: defineCommand({
        description: 'Delete a project',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        handler: async (p) => {
          await deleteProject(String(p.id));
        },
      }),
      openFile: defineCommand({
        description:
          'Open a file (or multiple files) in the editor. Use `path` for a single file or `files` array for multiple files.',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Single file path' },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Multiple file paths to open as tabs',
            },
          },
        },
        handler: async (p) => {
          const paths: string[] = [];
          if (Array.isArray(p.files)) paths.push(...p.files.map(String));
          if (p.path) paths.push(String(p.path));
          if (paths.length === 0) throw new AppCommandError('Provide path or files[]');
          for (const fp of paths) await openFile(fp);
          return { opened: paths };
        },
      }),
      readFile: defineCommand({
        description:
          'Read one or more files and return their contents with line numbers. Does NOT change the editor open state. ' +
          'Use `path` (string) for a single file or `path` (array) for multiple files. ' +
          'Optionally specify `startLine` / `endLine` for a line range (1-based, inclusive). ' +
          'Set `openInEditor: true` to also open each file in the editor.',
        params: {
          type: 'object',
          properties: {
            path: {
              oneOf: [
                { type: 'string', description: 'Single file path' },
                { type: 'array', items: { type: 'string' }, description: 'Multiple file paths' },
              ],
            },
            startLine: { type: 'number', description: 'Start line (1-based, inclusive)' },
            endLine: { type: 'number', description: 'End line (1-based, inclusive)' },
            openInEditor: { type: 'boolean', description: 'Also open file(s) in editor UI' },
          },
          required: ['path'],
        },
        handler: async (p) => {
          const rawPath = p.path;
          const paths: string[] = Array.isArray(rawPath) ? rawPath.map(String) : [String(rawPath)];
          const opts = {
            startLine: p.startLine != null ? Number(p.startLine) : undefined,
            endLine: p.endLine != null ? Number(p.endLine) : undefined,
          };
          const results = await Promise.all(paths.map((fp) => readFileContent(fp, opts)));
          if (p.openInEditor) {
            for (const fp of paths) await openFile(fp);
          }
          // Return as embedded resource blocks — gives Claude URI + MIME metadata per file
          const proj = activeProject();
          const projectId = proj?.id ?? 'unknown';
          return results.map((r) => ({
            type: 'resource' as const,
            resource: {
              uri: `yaar://storage/apps/devtools/projects/${projectId}/${r.path}`,
              text: r.content,
              mimeType: getMimeType(r.path),
            },
          }));
        },
      }),
      writeFile: defineCommand({
        description: 'Write content to a file. Objects are serialized as pretty-printed JSON.',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: {
              description: 'File body. A string is written verbatim; an object is JSON-serialized.',
            },
          },
          required: ['path', 'content'],
        },
        handler: async (p) => {
          // `String(content)` turned an object into the literal "[object Object]" and wrote that
          // to disk — silent corruption, and passing an object is the natural thing to do for
          // app.json. Mirrors copyFile/readFileContent, which already guard this way.
          const content =
            typeof p.content === 'string' ? p.content : JSON.stringify(p.content, null, 2);
          await writeFile(String(p.path), content);
        },
      }),
      editFile: defineCommand({
        description:
          'Edit a file in place. Three modes: (1) search/replace — pass search + replace ' +
          '(aliases: oldString/newString), first match only. (2) line range — pass ' +
          'startLine/endLine (1-based, inclusive) with optional replace; omitting replace (or ' +
          'passing "") deletes those lines. (3) multi-edit — pass edits, an array of ' +
          '{ search, replace } and/or { startLine, endLine, replace? } objects, applied ' +
          'sequentially in memory and written to disk once, all-or-nothing: if any edit fails, ' +
          'the error names its index and nothing is written. Line numbers in later edits refer ' +
          'to the content AFTER earlier edits have been applied. Returns ' +
          '{ editsApplied, lines } with the new line count.',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            search: {
              type: 'string',
              description:
                'Text to find (first match). Alias: oldString. Mutually exclusive with startLine/endLine.',
            },
            replace: {
              type: 'string',
              description:
                'Replacement text. Alias: newString. With startLine/endLine, omit or pass an empty string to delete the range.',
            },
            oldString: { type: 'string', description: 'Alias for search.' },
            newString: { type: 'string', description: 'Alias for replace.' },
            startLine: {
              type: 'number',
              description:
                'First line to replace (1-based, inclusive). Mutually exclusive with search.',
            },
            endLine: {
              type: 'number',
              description: 'Last line to replace (1-based, inclusive). Defaults to startLine.',
            },
            edits: {
              type: 'array',
              description:
                'Multiple edits applied sequentially in memory and written once (all-or-nothing). Takes precedence over the top-level single-edit params. Line numbers in later edits refer to the content after earlier edits.',
              items: {
                type: 'object',
                properties: {
                  search: { type: 'string' },
                  replace: { type: 'string' },
                  startLine: { type: 'number' },
                  endLine: { type: 'number' },
                },
              },
            },
          },
          required: ['path'],
        },
        handler: async (p) => {
          const normalize = (e: {
            search?: string;
            replace?: string;
            oldString?: string;
            newString?: string;
            startLine?: number;
            endLine?: number;
          }): EditSpec => {
            const search = e.search ?? e.oldString;
            const replace = e.replace ?? e.newString;
            return {
              ...(search !== undefined ? { search: String(search) } : {}),
              ...(replace !== undefined ? { replace: String(replace) } : {}),
              ...(e.startLine !== undefined ? { startLine: Number(e.startLine) } : {}),
              ...(e.endLine !== undefined ? { endLine: Number(e.endLine) } : {}),
            };
          };
          let edits: EditSpec[];
          if (Array.isArray(p.edits)) {
            if (p.edits.length === 0) throw new AppCommandError('edits array is empty');
            edits = p.edits.map(normalize);
          } else {
            edits = [normalize(p)];
          }
          try {
            return await editFile(String(p.path), edits);
          } catch (err) {
            throw err instanceof AppCommandError ? err : new AppCommandError(errMsg(err));
          }
        },
      }),
      deleteFile: defineCommand({
        description: 'Delete a file',
        params: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        handler: async (p) => {
          await deleteFile(String(p.path));
        },
      }),
      copyFile: defineCommand({
        description:
          'Copy a file to another path within the active project. ' +
          'Reads the source and writes it to the destination — destination directories are created automatically. ' +
          'Useful for restructuring (e.g. moving files into a subdirectory) without a separate read+write cycle. ' +
          'Does NOT delete the original; pair with deleteFile to move.',
        params: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Source file path (e.g. "src/Foo.ts")' },
            to: { type: 'string', description: 'Destination file path (e.g. "src/ui/Foo.ts")' },
          },
          required: ['from', 'to'],
        },
        handler: async (p) => {
          const from = String(p.from);
          const to = String(p.to);
          if (from === to) throw new AppCommandError('Source and destination are the same path');
          try {
            await copyFile(from, to);
            return { from, to };
          } catch (err) {
            throw new AppCommandError(errMsg(err));
          }
        },
      }),
      grep: defineCommand({
        description: 'Search file contents with regex across the project',
        params: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for' },
            glob: { type: 'string', description: 'File glob filter (e.g. "src/**/*.ts")' },
          },
          required: ['pattern'],
        },
        handler: async (p) => {
          const result = await grep(String(p.pattern), p.glob ? String(p.glob) : undefined);
          if (result.matches.length === 0) return 'No matches found.';
          // Group matches by file and return as embedded resource blocks
          const proj = activeProject();
          const projectId = proj?.id ?? 'unknown';
          const byFile = new Map<string, typeof result.matches>();
          for (const m of result.matches) {
            const arr = byFile.get(m.file) ?? [];
            arr.push(m);
            byFile.set(m.file, arr);
          }
          const blocks: {
            type: 'resource';
            resource: { uri: string; text: string; mimeType: string };
          }[] = [];
          for (const [file, matches] of byFile) {
            const lines = matches.map((m) => `${m.line}│${m.content}`).join('\n');
            blocks.push({
              type: 'resource',
              resource: {
                uri: `yaar://storage/apps/devtools/projects/${projectId}/${file}`,
                text: `── ${file} (${matches.length} matches) ──\n${lines}`,
                mimeType: getMimeType(file),
              },
            });
          }
          if (result.truncated) {
            return [...blocks, { type: 'text' as const, text: '(results truncated)' }];
          }
          return blocks;
        },
      }),
      compile: defineCommand({
        description:
          'Type check and compile the active project, and refresh the preview window if one is ' +
          'open. `status` is success only when the code both builds and type checks. Slow: ' +
          'pass timeoutMs (e.g. 60000).',
        params: {
          type: 'object',
          properties: {
            skipTypecheck: {
              type: 'boolean',
              description: 'Build without type checking first. Faster, but ships blind.',
            },
          },
        },
        handler: async (p) => {
          // Typecheck and compile were always run back-to-back as two round trips, and compiling
          // does not typecheck — so it was easy to ship code that built but never type checked.
          // Fold them: check first, build regardless, report both.
          const skip = p.skipTypecheck === true;
          if (!skip) await typecheck();
          await compile();
          const built = compileStatus() === 'success';
          const errors = compileErrors();
          const diags = skip ? [] : diagnostics();
          const typeErrors = diags.filter((d) => d.severity === 'error').length;

          // A bundle that built around two type errors used to come back `status: "success"`
          // with a previewUrl — the one word the caller reads, saying the one thing that
          // wasn't true. Bun strips types and builds happily through them, so "it built" and
          // "it type checks" are separate facts and both get reported: `built` for the
          // bundle, `status` for the code. Deploy enforces the same line.
          const status = built && typeErrors === 0 ? 'success' : 'error';

          // Refresh an open preview onto the build we just made. Left alone, it went on
          // showing the previous one — so a screenshot taken to confirm a fix showed the
          // code from before the fix, and agreed with you. Re-opening remounts the iframe,
          // which resets app state: a new build is a new app.
          let previewRefreshed = false;
          if (built && previewWindowId()) {
            await openPreview();
            previewRefreshed = true;
          }

          // Best-effort manifest drift check: with a freshly refreshed preview,
          // compare what the compiler extracted (what agents will see after
          // deploy) against what the running app actually registered. A command
          // reached via a spread or computed key runs fine but vanishes from
          // the static manifest — this is where that mismatch surfaces instead
          // of staying latent until deploy. Any fetch failure drops the check
          // silently; it is advisory, never a reason to fail a compile.
          let manifestDrift: ReturnType<typeof diffManifestNames> | undefined;
          if (previewRefreshed) {
            const statNames = staticProtocol()?.protocol;
            if (statNames) {
              await wait(800); // the remounted iframe needs a beat to boot and register
              const runtime = await getRuntimeManifest();
              if (runtime.names) {
                const drift = diffManifestNames(statNames, runtime.names);
                if (drift.missingFromStatic.length > 0 || drift.missingFromRuntime.length > 0) {
                  manifestDrift = drift;
                }
              }
            }
          }
          const protocolWarnings = staticProtocol()?.warnings ?? [];

          return {
            status,
            built,
            previewUrl: previewUrl(),
            ...(previewRefreshed ? { previewRefreshed } : {}),
            ...(typeErrors > 0 ? { typeErrors } : {}),
            ...(!built && errors.length > 0 ? { errors } : {}),
            ...(diags.length > 0 ? { diagnostics: diags } : {}),
            ...(protocolWarnings.length > 0 ? { protocolWarnings } : {}),
            ...(manifestDrift
              ? {
                  manifestDrift,
                  manifestNote:
                    'warning: the runtime registration and the static protocol manifest ' +
                    'disagree — entries reached via spreads or computed keys are invisible to ' +
                    'agents. Run the manifest command for details.',
                }
              : {}),
          };
        },
      }),
      typecheck: defineCommand({
        description: 'Run TypeScript type checker only. `compile` already does this.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await typecheck();
          return { diagnostics: diagnostics() };
        },
      }),
      manifest: defineCommand({
        description:
          'Inspect the app protocol manifest without deploying. Reports the STATIC manifest ' +
          '(command/state names the compiler extracted from source on the last compile — what ' +
          'agents will see after deploy) and the RUNTIME manifest (what the running preview ' +
          'actually registered via app.register), plus a drift report between the two. Drift ' +
          'means an entry is reached via a spread or computed key: it runs but is invisible to ' +
          'agents. Run compile first for the static side; open a preview for the runtime side.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          const stat = await getStaticManifest();
          const runtime = await getRuntimeManifest();
          const result = {
            static: stat.names
              ? {
                  available: true as const,
                  source: stat.source,
                  commands: stat.names.commands,
                  state: stat.names.state,
                  ...(stat.warnings.length > 0 ? { warnings: stat.warnings } : {}),
                }
              : {
                  available: false as const,
                  reason: stat.reason ?? 'Static manifest unavailable.',
                  ...(stat.warnings.length > 0 ? { warnings: stat.warnings } : {}),
                },
            runtime: runtime.names
              ? {
                  available: true as const,
                  commands: runtime.names.commands,
                  state: runtime.names.state,
                }
              : {
                  available: false as const,
                  reason: runtime.reason ?? 'Runtime manifest unavailable.',
                },
          };
          if (stat.names && runtime.names) {
            return { ...result, drift: diffManifestNames(stat.names, runtime.names) };
          }
          const note =
            !stat.names && !runtime.names
              ? 'Neither side is available — compile the project (static) and open a preview ' +
                '(runtime), then retry.'
              : !stat.names
                ? 'Only the runtime side is available, so no drift check was possible. ' +
                  (stat.reason ?? '')
                : 'Only the static side is available, so no drift check was possible. ' +
                  (runtime.reason ?? '');
          return { ...result, note: note.trim() };
        },
      }),
      protocolLog: defineCommand({
        description:
          'Read App Protocol traffic for the preview window — every query/command sent to it ' +
          'and every event it emitted, in order, with results and timings. Use this to see what ' +
          'the app actually did, rather than inferring it from source.',
        params: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max entries, newest last (default 100).' },
          },
        },
        handler: async (p) => {
          const wid = previewWindowId();
          if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
          return await invoke(`yaar://windows/${wid}`, {
            action: 'protocol_log',
            ...(typeof p.limit === 'number' ? { limit: p.limit } : {}),
          });
        },
      }),
      deploy: defineCommand({
        description:
          'Deploy to apps/. Type checks first and refuses to ship type errors. Snapshots the ' +
          'previous version first — see gitRestore.',
        params: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            name: { type: 'string' },
            icon: { type: 'string' },
            description: { type: 'string' },
            message: {
              type: 'string',
              description: 'Commit message for this deploy, e.g. "add dark mode toggle"',
            },
            skipTypecheck: {
              type: 'boolean',
              description: 'Ship despite type errors. Say so on purpose.',
            },
          },
          required: ['appId'],
        },
        handler: async (p) =>
          await deploy({
            appId: String(p.appId),
            name: p.name ? String(p.name) : undefined,
            icon: p.icon ? String(p.icon) : undefined,
            description: p.description ? String(p.description) : undefined,
            message: p.message ? String(p.message) : undefined,
            skipTypecheck: p.skipTypecheck === true,
          }),
      }),
      gitHistory: defineCommand({
        description:
          "List a deployed app's version history, newest first. Each deploy is one commit.",
        params: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App to inspect' },
            limit: { type: 'number', description: 'Max commits (default 30)' },
          },
          required: ['appId'],
        },
        handler: async (p) =>
          gitHistory(String(p.appId), typeof p.limit === 'number' ? p.limit : undefined),
      }),
      gitDiff: defineCommand({
        description:
          'Diff a deployed app. against="snapshot" (default) compares its current files to a ' +
          'commit in its own history — what changed since the last deploy. against="repo" compares ' +
          "to the user's git repo — what has changed relative to what the user committed (bundled apps only).",
        params: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App to diff' },
            ref: {
              type: 'string',
              description: 'Commit to compare against: a hash or HEAD~N. Default HEAD.',
            },
            against: { type: 'string', enum: ['snapshot', 'repo'] },
          },
          required: ['appId'],
        },
        handler: async (p) => {
          const result = await gitDiff(String(p.appId), {
            ref: p.ref ? String(p.ref) : undefined,
            against: p.against === 'repo' ? 'repo' : 'snapshot',
          });
          if (!result.diff) return { changed: false, files: [] };
          return {
            changed: true,
            files: result.files ?? [],
            diff: result.diff,
            ...(result.truncated ? { truncated: true } : {}),
          };
        },
      }),
      gitRestore: defineCommand({
        description:
          'Roll a deployed app back to an earlier commit and rebuild it. Use after a bad deploy. ' +
          'The current state is snapshotted first, so this is itself undoable.',
        params: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App to roll back' },
            ref: {
              type: 'string',
              description: 'Commit to restore: a hash from gitHistory, or HEAD~1 for the previous version.',
            },
          },
          required: ['appId', 'ref'],
        },
        handler: async (p) => gitRestore(String(p.appId), String(p.ref)),
      }),
      gitCheckpoint: defineCommand({
        description:
          "Snapshot a deployed app's current state as a commit, so you can return to it later.",
        params: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App to snapshot' },
            message: { type: 'string', description: 'What this checkpoint captures' },
          },
          required: ['appId'],
        },
        handler: async (p) =>
          gitCheckpoint(String(p.appId), p.message ? String(p.message) : undefined),
      }),
      preview: defineCommand({
        description: 'Open preview window for the compiled app',
        params: { type: 'object', properties: {} },
        handler: async () => await openPreview(),
      }),
      viewPreview: defineCommand({
        description:
          'Read the preview window: a screenshot of what is actually on screen, plus its ' +
          'size and position. Look at the picture before theorizing about a rendering bug.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          const { info, images } = await readPreview();
          // Content blocks pass through to the agent untouched (wrapAppValue), so the
          // image arrives as an image and not as a wall of base64.
          return [
            { type: 'text', text: JSON.stringify(info, null, 2) },
            ...images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType })),
          ];
        },
      }),
      previewScreenshot: defineCommand({
        description:
          'See the preview — a screenshot of the running app, nothing else. Use it whenever a ' +
          'question is about pixels ("is it blank?", "did that render?"): looking costs one ' +
          'call and settles it, where reasoning from source can be confidently wrong.',
        params: { type: 'object', properties: {} },
        handler: async () => {
          const { images } = await readPreview();
          if (images.length === 0) {
            throw new AppCommandError(
              'Preview window returned no screenshot. The iframe may not have painted yet — ' +
                'give it a moment after preview/compile, then retry.',
            );
          }
          return images.map((img) => ({
            type: 'image',
            data: img.data,
            mimeType: img.mimeType,
          }));
        },
      }),
      previewQuery: defineCommand({
        description: 'Query app protocol state from the preview window',
        params: {
          type: 'object',
          properties: { stateKey: { type: 'string', description: 'State key to query' } },
          required: ['stateKey'],
        },
        handler: async (p) => {
          const wid = previewWindowId();
          if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
          try {
            return await invoke(`yaar://windows/${wid}`, {
              action: 'app_query',
              stateKey: String(p.stateKey),
            });
          } catch (err) {
            throw new AppCommandError(`Preview query failed: ${errMsg(err)}`);
          }
        },
      }),
      previewCommand: defineCommand({
        description: 'Send an app protocol command to the preview window',
        params: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command name' },
            params: { type: 'object', description: 'Command parameters' },
          },
          required: ['command'],
        },
        handler: async (p) => {
          const wid = previewWindowId();
          if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
          try {
            return await invoke(`yaar://windows/${wid}`, {
              action: 'app_command',
              command: String(p.command),
              params: (p.params as Record<string, unknown>) ?? {},
            });
          } catch (err) {
            throw new AppCommandError(`Preview command failed: ${errMsg(err)}`);
          }
        },
      }),
      resizePreview: defineCommand({
        description:
          'Resize the preview window to width × height pixels. Use this to give a preview more ' +
          'room (e.g. testing a wide layout) instead of relaying the request to the monitor. ' +
          'Unlike re-running preview, this does not remount the iframe, so preview state is kept.',
        params: {
          type: 'object',
          properties: {
            width: { type: 'number', description: 'New width in pixels' },
            height: { type: 'number', description: 'New height in pixels' },
          },
          required: ['width', 'height'],
        },
        handler: async (p) => {
          const wid = previewWindowId();
          if (!wid) throw new AppCommandError('No preview window open. Run preview first.');
          const width = Number(p.width);
          const height = Number(p.height);
          if (!(width > 0) || !(height > 0)) {
            throw new AppCommandError('width and height must be positive numbers.');
          }
          try {
            return await invoke(`yaar://windows/${wid}`, { action: 'resize', width, height });
          } catch {
            setPreviewWindowId(null);
            throw new AppCommandError('Preview window no longer exists. Run preview first.');
          }
        },
      }),
      describeUri: defineCommand({
        description:
          'Describe a yaar:// URI — returns supported verbs, description, and invoke schema',
        params: {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
              description: 'yaar:// URI to describe (e.g. "yaar://sessions/")',
            },
          },
          required: ['uri'],
        },
        handler: async (p) => {
          try {
            const result = await describe(String(p.uri));
            return { result };
          } catch (err) {
            throw new AppCommandError(`Failed to describe URI ${p.uri}: ${errMsg(err)}`);
          }
        },
      }),
      listUri: defineCommand({
        description: 'List child resources under a yaar:// URI',
        params: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: 'yaar:// URI to list (e.g. "yaar://sessions/")' },
          },
          required: ['uri'],
        },
        handler: async (p) => {
          try {
            const result = await list(String(p.uri));
            return { items: result };
          } catch (err) {
            throw new AppCommandError(`Failed to list URI ${p.uri}: ${errMsg(err)}`);
          }
        },
      }),
      cloneApp: defineCommand({
        description: 'Clone an installed app source into a new project',
        params: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App ID to clone' },
          },
          required: ['appId'],
        },
        handler: async (p) => {
          const projectId = await cloneApp(String(p.appId));
          const proj = activeProject();
          return {
            projectId,
            project: proj ? { id: proj.id, name: proj.name } : undefined,
            files: files().map((f) => f.path),
          };
        },
      }),
      describeBundledLibrary: defineCommand({
        description: 'Get detailed type information (methods, interfaces) for a @bundled/* library',
        params: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Library name (e.g. "yaar", "anime", "three")' },
          },
          required: ['name'],
        },
        handler: async (p) => {
          try {
            const result = await bundledLibraries(String(p.name));
            return result;
          } catch (err) {
            throw new AppCommandError(errMsg(err));
          }
        },
      }),
      clearConsole: defineCommand({
        description: 'Clear console output',
        params: { type: 'object', properties: {} },
        handler: () => {
          clearConsoleLogs();
        },
      }),
    },
  });
}
