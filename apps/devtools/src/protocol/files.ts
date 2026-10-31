import { AppCommandError, errMsg, defineAppCommand } from '@bundled/yaar';
import { activeProject, requireProject } from '../core';
import {
  appSourceRef,
  assetImportLine,
  editText,
  formatGrepHits,
  isImagePath,
  isModelPath,
  markdownSection,
  type EditSpec,
} from '../lib';
import {
  openFile,
  writeFile,
  editFile,
  deleteFile,
  copyFile,
  grep,
  findReferences,
  typeAt,
  readFileContent,
  readFileText,
  readMediaFile,
  readModelSummary,
  listProjectFiles,
  resolveProjectPath,
  copyFromApp,
  copyFromStorage,
  exportToStorage,
  defaultAssetPath,
  isStorageRef,
  resolveStorageSource,
  SIZE_WARN_BYTES,
} from '../services';

import { getMimeType, imageBlocks, type ReadBlock } from './read-blocks';

function inlineSizeWarning(path: string, bytes: number): string {
  return (
    `${path} is ${Math.round(bytes / 1000)}KB and will be inlined as base64 ` +
    `(~${Math.round((bytes * 1.33) / 1000)}KB in the bundle). Consider a smaller source, ` +
    `or deploying the file to the app's own storage and fetching it at runtime.`
  );
}

/** A string lands verbatim; anything else is the JSON the caller most likely meant. */
function serialize(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

/**
 * Join an array-of-lines payload into a file body.
 *
 * The array form exists because a whole file as one JSON string is a single long
 * token full of `\n` and `\"` escapes, and that is the payload that has been
 * arriving truncated (issue #60). One element per line keeps every string short.
 * Elements are lines, so nothing is added between them but the newline, and no
 * trailing newline is appended — a caller that wants one passes a final `''`.
 *
 * A nested object here would stringify to "[object Object]" and be written to disk,
 * the same silent corruption the scalar path guards against, so it is refused by
 * index rather than coerced.
 */
function joinLines(lines: unknown[]): string {
  return lines
    .map((line, i) => {
      if (typeof line === 'string') return line;
      if (line === null || typeof line === 'object')
        throw new AppCommandError(
          `content[${i}] is ${line === null ? 'null' : 'an object'}; every element of a ` +
            'content array must be a string (one line of the file). Pass the object as ' +
            '`content` on its own to get JSON serialization.',
        );
      return String(line);
    })
    .join('\n');
}

/**
 * A path inside the active project, with no way out of the sandbox.
 *
 * Leading slashes are tolerated because a caller pasting a path from a listing tends
 * to bring one; `..` is refused outright rather than normalized, since a caller who
 * wrote it meant somewhere this command does not go.
 *
 * `role` only names the offending side in the refusal. Both ends of an export are
 * checked — the source is as much a way out of the project as the destination is,
 * and a caller who wrote `..` on either deserves to read which one.
 */
function projectRelative(raw: string, role: 'Source' | 'Destination' = 'Destination'): string {
  const path = raw.replace(/^\/+/, '');
  if (!path) throw new AppCommandError(`${role} path is empty.`);
  if (path.split('/').includes('..'))
    throw new AppCommandError(`${role} "${raw}" escapes the project.`);
  return path;
}

const projectDestination = (raw: string): string => projectRelative(raw);

/** A service failure as the agent reads it; an `AppCommandError` already is one. */
function asCommandError(err: unknown): AppCommandError {
  return err instanceof AppCommandError ? err : new AppCommandError(errMsg(err));
}

// files/copy's four doors, one function each. `run` only picks the door.

/**
 * `recompress` is refused rather than ignored outside a storage import — silently
 * dropping it would report a WebP conversion that did not happen. `why` says what
 * the door does instead.
 */
function rejectRecompress(recompress: unknown, why: string): void {
  if (recompress !== undefined)
    throw new AppCommandError(`\`recompress\` applies only to a yaar://storage/... import; ${why}`);
}

/** An import's result: the import line when `to` is a src/ asset, and the inlining warning. */
function importResult<T extends object>(result: T, to: string, bytes: number) {
  const importLine = assetImportLine(to);
  return {
    ...result,
    ...(importLine ? { importLine } : {}),
    ...(bytes > SIZE_WARN_BYTES ? { warning: inlineSizeWarning(to, bytes) } : {}),
  };
}

/**
 * Another app's source is read-only and arrives in the clone payload, so it can only
 * go into this project, and only as the bytes the app ships.
 */
async function importFromApp(
  appRef: { appId: string; path: string },
  toRef: string | undefined,
  recompress: unknown,
) {
  if (toRef !== undefined && isStorageRef(toRef))
    throw new AppCommandError(
      "An installed app's file can only be copied into the project. Copy it here " +
        'first, then export that copy to storage.',
    );
  rejectRecompress(recompress, "an app's file is copied byte for byte.");
  const to = projectDestination(toRef ?? defaultAssetPath(appRef.path));
  try {
    const copied = await copyFromApp(appRef.appId, appRef.path, to);
    return importResult({ from: copied.from, to, bytes: copied.bytes }, to, copied.bytes);
  } catch (err) {
    throw asCommandError(err);
  }
}

/**
 * The export door: a project file out to storage, so another app can open it.
 * Refused when `from` is itself a storage URI — that is a storage-to-storage copy,
 * which the storage app does directly and this project has no part in.
 */
async function exportFromProject(from: string, toRef: string, recompress: unknown) {
  if (isStorageRef(from))
    throw new AppCommandError(
      'Both `from` and `to` name storage. A storage-to-storage copy does not involve ' +
        'the project — invoke it on yaar://storage/... directly.',
    );
  rejectRecompress(recompress, 'an export is byte for byte.');
  const destination = resolveStorageSource(toRef);
  if (!destination) throw new AppCommandError('`to` names the storage root, not a file.');
  try {
    const exported = await exportToStorage(projectRelative(from, 'Source'), destination);
    return { from, ...exported };
  } catch (err) {
    throw new AppCommandError(errMsg(err));
  }
}

/** A copy within the project: unchanged behaviour, and deliberately never re-encoded. */
async function copyWithinProject(from: string, toRef: string | undefined, recompress: unknown) {
  if (toRef === undefined)
    throw new AppCommandError(
      '`to` is required when copying within the project. Only a yaar://storage/... ' +
        'or yaar://apps/... source defaults to src/assets/.',
    );
  rejectRecompress(recompress, 'a copy within the project is byte for byte.');
  const to = projectDestination(toRef);
  if (from === to) throw new AppCommandError('Source and destination are the same path');
  try {
    const { bytes } = await copyFile(from, to);
    return { from, to, bytes };
  } catch (err) {
    throw new AppCommandError(errMsg(err));
  }
}

/** The import door: a storage file into the project, re-encoded as `planAssetImport` decides. */
async function importFromStorage(from: string, toRef: string | undefined, recompress: unknown) {
  const requested = toRef !== undefined;
  try {
    const sourcePath = resolveStorageSource(from);
    const result = await copyFromStorage(
      sourcePath,
      projectDestination(requested ? toRef : defaultAssetPath(sourcePath)),
      {
        ...(recompress !== undefined ? { recompress: Boolean(recompress) } : {}),
        // An explicit `to` is honoured as written, extension included; only a
        // defaulted path follows the bytes to .webp.
        renameToWebP: !requested,
      },
    );
    return importResult(
      {
        from: `yaar://storage/${sourcePath}`,
        to: result.path,
        bytes: result.bytes,
        recompressed: result.recompressed,
      },
      result.path,
      result.bytes,
    );
  } catch (err) {
    throw asCommandError(err);
  }
}

const textOrLines = (description: string) => ({
  oneOf: [
    { type: 'string' },
    { type: 'array', items: { type: 'string' }, description: 'Lines, joined with "\\n".' },
  ],
  description,
});

export const fileCommands = {
  'files/read': defineAppCommand({
    description:
      'Read one or more files. A missing file throws `file not found: {path}` with nearby ' +
      'paths; a path that climbs out of the project throws `refused: path escapes the ' +
      'project`. Paths are normalized (`src/../app.json` is `app.json`). With an array, an ' +
      'unreadable file becomes its own `[files/read error]` text block beside the rest; the ' +
      'call throws only when none could be read, or a path is refused. ' +
      'Image files come back as a viewable image block, not text; a .glb/.gltf as its ' +
      '`inspect/model` summary. `section` reads one Markdown section by its heading — the ' +
      'outline `project/cloneApp` returns for AGENTS.md names them.',
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
        section: {
          type: 'string',
          description:
            'A Markdown heading ("Layers", or "## Layers"): reads from it to the next heading ' +
            'of its level or higher, subsections included. Exact text wins, else a unique ' +
            'substring; an ambiguous one is refused with the candidates. One path only, ' +
            'and not with startLine/endLine.',
        },
        lineNum: {
          type: 'boolean',
          description: 'Prefix each line with its number. Default false.',
        },
        openInEditor: { type: 'boolean', description: 'Also open file(s) in editor UI' },
      },
      required: ['path'],
    },
    run: async (p) => {
      const rawPaths = Array.isArray(p.path) ? p.path.map(String) : [String(p.path)];
      requireProject(AppCommandError);
      let paths: string[];
      try {
        paths = rawPaths.map(resolveProjectPath);
      } catch (err) {
        throw new AppCommandError(errMsg(err));
      }
      const opts = {
        startLine: p.startLine != null ? Number(p.startLine) : undefined,
        endLine: p.endLine != null ? Number(p.endLine) : undefined,
        lineNum: Boolean(p.lineNum),
      };
      if (p.section != null) {
        if (paths.length !== 1) throw new AppCommandError('`section` reads one path at a time.');
        if (opts.startLine !== undefined || opts.endLine !== undefined)
          throw new AppCommandError('Pass `section` or a line range, not both.');
        const text = await readFileText(paths[0]);
        if (text == null) throw new AppCommandError(`file not found: ${paths[0]}`);
        const found = markdownSection(text, String(p.section));
        if ('error' in found) throw new AppCommandError(`${paths[0]}: ${found.error}`);
        opts.startLine = found.startLine;
        opts.endLine = found.endLine;
      }
      if (p.openInEditor) {
        for (const fp of paths) await openFile(fp);
      }
      const proj = activeProject();
      const projectId = proj?.id ?? 'unknown';
      const uriFor = (fp: string) => `yaar://storage/apps/devtools/projects/${projectId}/${fp}`;

      const perFile = await Promise.all(
        paths.map(async (fp): Promise<{ blocks: ReadBlock[] } | { error: string }> => {
          try {
            // An image is answered with the picture. Decoding it as text produced
            // mojibake, and handing back base64 would be a wall of characters that
            // says nothing — an image block is the only form that can be read.
            if (isImagePath(fp)) {
              const image = await readMediaFile(fp);
              if (image) return { blocks: imageBlocks(fp, [image]) };
              // Unreadable as bytes — fall through to the text path, which reports it.
            }
            // A model is answered with its structure, not its bytes: `inspect/model` with
            // no options, so the tree and bounds arrive without a second call.
            if (isModelPath(fp)) {
              return { blocks: [{ type: 'text', text: await readModelSummary(fp) }] };
            }
            const r = await readFileContent(fp, opts);
            // Embedded resource block — gives Claude URI + MIME metadata per file
            const uri = uriFor(r.path);
            return {
              blocks: [
                {
                  type: 'resource',
                  resource: { uri, text: r.content, mimeType: getMimeType(r.path) },
                },
              ],
            };
          } catch (err) {
            return { error: errMsg(err) };
          }
        }),
      );
      const errors = perFile.flatMap((r) => ('error' in r ? [r.error] : []));
      if (errors.length === perFile.length) throw new AppCommandError(errors.join('\n'));
      // A plain text block, never a resource: a failure dressed as file content is
      // exactly what made a missing file read like a file holding one comment.
      return perFile.flatMap((r): ReadBlock[] =>
        'error' in r ? [{ type: 'text', text: `[files/read error] ${r.error}` }] : r.blocks,
      );
    },
  }),
  'files/write': defineAppCommand({
    description:
      'Write content to a file. Content may be a string, an array of lines (joined with "\\n", ' +
      'no trailing newline added), or an object (serialized as pretty-printed JSON). Prefer the ' +
      'array form for anything longer than a few lines: one line per element keeps each JSON ' +
      'string short, where one long escaped-newline string risks truncation. ' +
      'Returns { path, lines, bytes } for what landed — check it when you passed an object, since ' +
      'that is where the serialization can surprise you. An array of OBJECTS is refused rather ' +
      'than stringified: the array form is for lines of text.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: {
          description:
            'File body. A string is written verbatim; an array of strings is joined with ' +
            'newlines (one element per line); an object is JSON-serialized.',
        },
      },
      required: ['path', 'content'],
    },
    replay: 'never',
    run: async (p) => {
      // `String(content)` turned an object into the literal "[object Object]" and wrote that
      // to disk — silent corruption, and passing an object is the natural thing to do for
      // app.json. Mirrors copyFile/readFileContent, which already guard this way.
      const content = Array.isArray(p.content) ? joinLines(p.content) : serialize(p.content);
      return await writeFile(String(p.path), content);
    },
  }),
  'files/edit': defineAppCommand({
    description:
      'Edit a file in place. Three modes: (1) search/replace — pass search + replace, first ' +
      'match only. (2) line range — pass startLine/endLine (1-based, inclusive) and anchor ' +
      '(REQUIRED: current text of startLine, compared trimmed; mismatch rejects the edit and ' +
      'writes nothing) with optional replace; omit replace to delete the range. ' +
      '(3) multi-edit — pass edits, an array of single-edit objects, applied sequentially in ' +
      'memory and written once, all-or-nothing: any failure names which edit failed, counting ' +
      'from 1 ("edit 2 of 3"), and nothing is written; later line numbers refer to content ' +
      'after earlier edits. search and replace take a string or an array of lines ' +
      '(joined with "\\n", no trailing newline added); any other type is refused. Returns ' +
      '{ editsApplied, lines, removed } — removed echoes the replaced text (truncated, middle elided).',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        search: textOrLines(
          'Text to find (first match). Mutually exclusive with startLine/endLine.',
        ),
        replace: textOrLines(
          'Replacement text. With startLine/endLine, omit or pass an empty string to delete the range.',
        ),
        startLine: {
          type: 'number',
          description:
            'First line to replace (1-based, inclusive). Mutually exclusive with search.',
        },
        endLine: {
          type: 'number',
          description: 'Last line to replace (1-based, inclusive). Defaults to startLine.',
        },
        anchor: {
          type: 'string',
          description:
            'Required with startLine/endLine: the current text of startLine (compared trimmed). Mismatch rejects the edit and reports the actual line text; nothing is written.',
        },
        edits: {
          type: 'array',
          description:
            'Multiple edits applied sequentially in memory and written once (all-or-nothing). Takes precedence over the top-level single-edit params. Line numbers in later edits refer to the content after earlier edits.',
          items: {
            type: 'object',
            properties: {
              search: textOrLines('Text to find (first match).'),
              replace: textOrLines('Replacement text.'),
              startLine: { type: 'number' },
              endLine: { type: 'number' },
              anchor: { type: 'string', description: 'Required with startLine/endLine.' },
            },
          },
        },
      },
      required: ['path'],
    },
    replay: 'never',
    run: async (p) => {
      const normalize = (
        e: {
          search?: unknown;
          replace?: unknown;
          startLine?: number;
          endLine?: number;
          anchor?: unknown;
        },
        at: string,
      ): EditSpec => {
        const text = (value: unknown, field: string) => {
          try {
            return editText(value, `${at}${field}`);
          } catch (err) {
            throw new AppCommandError(errMsg(err));
          }
        };
        const search = text(e.search, 'search');
        const replace = text(e.replace, 'replace');
        const anchor = e.anchor;
        if (anchor !== undefined && typeof anchor !== 'string')
          throw new AppCommandError(
            `${at}anchor must be a string: the current text of startLine, one line.`,
          );
        return {
          ...(search !== undefined ? { search } : {}),
          ...(replace !== undefined ? { replace } : {}),
          ...(e.startLine !== undefined ? { startLine: Number(e.startLine) } : {}),
          ...(e.endLine !== undefined ? { endLine: Number(e.endLine) } : {}),
          ...(typeof anchor === 'string' ? { anchor } : {}),
        };
      };
      let edits: EditSpec[];
      if (Array.isArray(p.edits)) {
        if (p.edits.length === 0) throw new AppCommandError('edits array is empty');
        edits = p.edits.map((e, i) => normalize(e, `edits[${i}].`));
      } else {
        edits = [normalize(p, '')];
      }
      try {
        return await editFile(String(p.path), edits);
      } catch (err) {
        throw asCommandError(err);
      }
    },
  }),
  'files/delete': defineAppCommand({
    description: 'Delete a project file. With no project open it does nothing, without erroring.',
    params: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    replay: 'never',
    run: async (p) => {
      await deleteFile(String(p.path));
    },
  }),
  'files/copy': defineAppCommand({
    description:
      'Copy a file. `from` and `to` are project-relative; ONLY a `yaar://` prefix names ' +
      'something outside the project. A `yaar://storage/...` side imports or exports ' +
      'server-side and byte-exact, the only way to hand a file over: a binary read into ' +
      'this conversation and written back is corrupted. `from` may also be ' +
      "`yaar://apps/{appId}/{path}`, an installed app's file. The result carries the import " +
      'line for an asset under src/. 3D models: a self-contained .glb, not a .gltf. Creates ' +
      'directories; keeps the original (pair with files/delete to move).',
    params: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description:
            'Source: a project-relative path ("src/Foo.ts"), a yaar://storage/... URI ' +
            '("yaar://storage/shared/anima/dragon.png") to import a file from storage, or ' +
            'a yaar://apps/{appId}/... URI ("yaar://apps/mascot/src/assets/idle.png") to ' +
            "copy a file out of an installed app's source.",
        },
        to: {
          type: 'string',
          description:
            'Destination: a project-relative path ("src/ui/Foo.ts"), or a yaar://storage/... ' +
            'URI ("yaar://storage/shared/devtools/level01.json") to export the file out to ' +
            'storage. Required except for an import, where it defaults to ' +
            'src/assets/<source name>.',
        },
        recompress: {
          type: 'boolean',
          description:
            'Storage imports only. Re-encode a raster image to WebP. Default: on for ' +
            'JPEG/BMP, off for PNG (lossless — pixel art survives). true with an explicit ' +
            '`to` needs a .webp name; false keeps the original bytes exactly.',
        },
      },
      required: ['from'],
    },
    replay: 'never',
    run: async (p) => {
      requireProject(AppCommandError);
      const from = String(p.from);
      const toRef = p.to === undefined ? undefined : String(p.to);
      const appRef = appSourceRef(from);
      if (appRef) return importFromApp(appRef, toRef, p.recompress);
      if (toRef !== undefined && isStorageRef(toRef))
        return exportFromProject(from, toRef, p.recompress);
      if (!isStorageRef(from)) return copyWithinProject(from, toRef, p.recompress);
      return importFromStorage(from, toRef, p.recompress);
    },
  }),
  'files/list': defineAppCommand({
    description:
      "List the active project's files as { path, isDirectory, lines?, bytes? } — `lines` " +
      'for text, `bytes` for every file, neither for a directory. Generated output is ' +
      'skipped as files/grep skips it unless includeBuilt; `excluded` counts it. Throws with ' +
      'no active project, or when `dir` names no directory.',
    params: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description:
            'Only entries under this project-relative directory ("src/ui"). Default: the ' +
            'whole project.',
        },
        glob: {
          type: 'string',
          description:
            'Filter on the whole project-relative path. `*` stops at "/", so "*.ts" is ' +
            'root files only; "**/*.ts" is any depth, root included; "src/**/*.{ts,css}" ' +
            'alternates.',
        },
        includeBuilt: {
          type: 'boolean',
          description: 'List generated output too (default false).',
        },
      },
    },
    run: async (p) => {
      try {
        const result = await listProjectFiles({
          ...(p.dir !== undefined ? { dir: String(p.dir) } : {}),
          ...(p.glob ? { glob: String(p.glob) } : {}),
          includeBuilt: p.includeBuilt === true,
        });
        return {
          dir: result.dir,
          count: result.files.length,
          files: result.files,
          ...(result.excluded
            ? {
                excluded: result.excluded,
                note: `${result.excluded} generated entr${result.excluded === 1 ? 'y' : 'ies'} skipped — pass includeBuilt to list them`,
              }
            : {}),
        };
      } catch (err) {
        throw new AppCommandError(errMsg(err));
      }
    },
  }),
  'files/grep': defineAppCommand({
    description:
      'Search file contents with regex across the project, source only: generated output ' +
      '(dist/, build/, out/, node_modules/, coverage/, .git/, and .min.js/.map files) is ' +
      'skipped unless includeBuilt. At most 100 matches a page: a closing note gives the ' +
      'total and the next `offset`. A line over 300 characters comes back as a window ' +
      'around the match, marked `…[+N chars]` on each cut side — files/read with a line ' +
      'range for the whole line. Empty with no project open.',
    params: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        glob: { type: 'string', description: 'File glob filter (e.g. "src/**/*.ts")' },
        includeBuilt: {
          type: 'boolean',
          description:
            'Search generated output too (default false). For when the built output IS the ' +
            'subject — checking what the bundler emitted, or whether a string survived into ' +
            'dist/. Expect minified lines.',
        },
        offset: {
          type: 'number',
          description: 'Skip this many matches, as the closing note says. Reads every file.',
        },
        context: {
          type: 'number',
          description:
            'Lines to show around each hit, up to 10: `12-│text` beside a hit `13│text`, `--` ' +
            'between runs that do not touch. Reads every file.',
        },
      },
      required: ['pattern'],
    },
    run: async (p) => {
      const offset = typeof p.offset === 'number' ? p.offset : 0;
      const result = await grep(
        String(p.pattern),
        p.glob ? String(p.glob) : undefined,
        p.includeBuilt === true,
        {
          offset,
          ...(typeof p.context === 'number' ? { context: p.context } : {}),
        },
      );
      // An empty result after filtering is not the same answer as no match anywhere, and
      // reporting it as one sends the caller looking for a string they already found.
      if (result.matches.length === 0) {
        if ((result.total ?? 0) > 0) {
          return `No matches past offset ${offset}: there are ${result.total}.`;
        }
        return result.excluded
          ? `No matches in source. ${result.excluded} match(es) were in generated output — pass includeBuilt to see them.`
          : 'No matches found.';
      }
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
        const lines = formatGrepHits(matches);
        blocks.push({
          type: 'resource',
          resource: {
            uri: `yaar://storage/apps/devtools/projects/${projectId}/${file}`,
            text: `── ${file} (${matches.length} matches) ──\n${lines}`,
            mimeType: getMimeType(file),
          },
        });
      }
      const first = offset + 1;
      const last = offset + result.matches.length;
      const notes = [
        result.nextOffset !== undefined || offset > 0
          ? `matches ${first}-${last} of ${result.total}`
          : `${result.total} match(es)`,
        ...(result.nextOffset !== undefined ? [`next page: offset ${result.nextOffset}`] : []),
        ...(result.excluded
          ? [
              `${result.excluded} match(es) in generated output skipped — pass includeBuilt for those`,
            ]
          : []),
      ];
      return [...blocks, { type: 'text' as const, text: `(${notes.join('; ')})` }];
    },
  }),
  'files/findReferences': defineAppCommand({
    description:
      'Find every reference to a TypeScript symbol in the project via the language service, ' +
      'not a text search: follows re-exports, renamed imports and methods called through an ' +
      'instance. Name it by `symbol` (declared in `file`), by `line`+`column`, or by ' +
      '`line`+`symbol`. Returns { symbol, at, definitions, references: [{ file, line, column, ' +
      'text, enclosing, isDefinition?, isWrite?, isCall?, role? }], totalReferences, ' +
      'testReferences, files }, plus `callers` when asked. Production references come ' +
      'before test files (`*.test.ts`, `test/`), so a cap clips tests first; ' +
      '`ambiguous` lists other matching declarations — re-ask with ' +
      '`line`. Only `src/**/*.ts` files resolve; throws with the reason (not-found, invalid, ' +
      'unavailable, timeout) rather than answering zero references. Reads saved files, so ' +
      'no compile is needed first.',
    params: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description:
            'Project-relative file the symbol is declared or used in, e.g. "src/main.ts".',
        },
        symbol: {
          type: 'string',
          description:
            'Name declared in `file` — `setBlocks`, or `Class.method` / `obj.prop` for a member. ' +
            'With `line`, the first occurrence of that name on that line.',
        },
        line: { type: 'number', description: '1-based line.' },
        column: { type: 'number', description: '1-based column. Needs `line`.' },
        callers: {
          type: 'boolean',
          description:
            'Also return who calls it, grouped by enclosing function, or by property path ' +
            'for a handler in an object literal (`fileCommands.files/grep.run`).',
        },
        maxResults: {
          type: 'number',
          description: 'Cap on references and callers (default 200); `truncated` says it clipped.',
        },
        excludeTests: {
          type: 'boolean',
          description: 'Leave test files out entirely (default false: listed last).',
        },
      },
      required: ['file'],
    },
    run: async (p) => {
      const symbol = p.symbol ? String(p.symbol) : undefined;
      const line = typeof p.line === 'number' ? p.line : undefined;
      const column = typeof p.column === 'number' ? p.column : undefined;
      if (!symbol && line === undefined) {
        throw new AppCommandError('Pass `symbol`, or `line` (with `column` or `symbol`).');
      }
      if (column !== undefined && line === undefined) {
        throw new AppCommandError('`column` needs `line`.');
      }
      return await findReferences({
        file: String(p.file),
        ...(symbol ? { symbol } : {}),
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
        ...(p.callers === true ? { callers: true } : {}),
        ...(typeof p.maxResults === 'number' ? { maxResults: p.maxResults } : {}),
        ...(p.excludeTests === true ? { excludeTests: true } : {}),
      });
    },
  }),
  'files/typeAt': defineAppCommand({
    description:
      'The type the checker reports for a symbol — the hover text an editor shows — from ' +
      "files/findReferences' language service: no typecheck, bundle or preview reload. Ask it " +
      'before writing a call against an API you have not checked, or to read what an ' +
      'inferred value actually is. Named the same way as files/findReferences: `symbol` ' +
      '(declared in `file`), `line`+`column`, or `line`+`symbol` for a use. Returns ' +
      '{ symbol, at, kind, type, documentation?, tags?, definition? } — `type` is the ' +
      'declaration as printed (`const rows: Accessor<Row[]>`), `definition` where it is ' +
      'declared, including inside @bundled/* declarations. Reads saved files.',
    params: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Project-relative file, e.g. "src/main.ts".',
        },
        symbol: {
          type: 'string',
          description:
            'Name declared in `file` (`Class.method` for a member); with `line`, the first ' +
            'occurrence of that name on the line — the way to ask about a use.',
        },
        line: { type: 'number', description: '1-based line.' },
        column: { type: 'number', description: '1-based column. Needs `line`.' },
      },
      required: ['file'],
    },
    replay: 'never',
    run: async (p) => {
      const symbol = p.symbol ? String(p.symbol) : undefined;
      const line = typeof p.line === 'number' ? p.line : undefined;
      const column = typeof p.column === 'number' ? p.column : undefined;
      if (!symbol && column === undefined) {
        throw new AppCommandError('Pass `symbol`, or `line` with `column` or `symbol`.');
      }
      if (column !== undefined && line === undefined) {
        throw new AppCommandError('`column` needs `line`.');
      }
      return await typeAt({
        file: String(p.file),
        ...(symbol ? { symbol } : {}),
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
      });
    },
  }),
};
