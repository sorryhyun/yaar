import { AppCommandError, defineCommand, errMsg } from '@bundled/yaar';
import {
  activeProject,
  openFile,
  writeFile,
  editFile,
  deleteFile,
  copyFile,
  grep,
  readFileContent,
  readImageFile,
  isImagePath,
  type EditSpec,
} from '../project';

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

/** The block shapes `readFile` returns. Image blocks pass through the app protocol as-is. */
type ReadBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text: string; mimeType: string } };

/**
 * Above this an inlined image costs more than it tells anyone — a project asset that
 * big is a mistake worth naming rather than rendering. (Base64 is ~4/3 of the bytes,
 * and the model's own per-image ceiling is near 5MB encoded.)
 */
const MAX_INLINE_IMAGE_BYTES = 3_500_000;

function imageBlocks(path: string, image: { data: string; mimeType: string }): ReadBlock[] {
  const kb = Math.round((image.data.length * 3) / 4 / 1024);
  if ((image.data.length * 3) / 4 > MAX_INLINE_IMAGE_BYTES) {
    return [
      {
        type: 'text',
        text: `── ${path} ──\n(image, ${kb}KB — too large to inline; open it in the editor with openFile)`,
      },
    ];
  }
  return [
    { type: 'text', text: `── ${path} (image, ${kb}KB) ──` },
    { type: 'image', data: image.data, mimeType: image.mimeType },
  ];
}

export const fileCommands = {
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
      'Set `openInEditor: true` to also open each file in the editor. ' +
      'Image files come back as an image you can see, not as text.',
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
      if (p.openInEditor) {
        for (const fp of paths) await openFile(fp);
      }
      const proj = activeProject();
      const projectId = proj?.id ?? 'unknown';
      const uriFor = (fp: string) => `yaar://storage/apps/devtools/projects/${projectId}/${fp}`;

      const perFile = await Promise.all(
        paths.map(async (fp): Promise<ReadBlock[]> => {
          // An image is answered with the picture. Decoding it as text produced
          // mojibake, and handing back base64 would be a wall of characters that
          // says nothing — an image block is the only form that can be read.
          if (isImagePath(fp)) {
            const image = await readImageFile(fp);
            if (image) return imageBlocks(fp, image);
            // Unreadable as bytes — fall through to the text path, which reports it.
          }
          const r = await readFileContent(fp, opts);
          // Embedded resource block — gives Claude URI + MIME metadata per file
          return [
            {
              type: 'resource',
              resource: { uri: uriFor(r.path), text: r.content, mimeType: getMimeType(r.path) },
            },
          ];
        }),
      );
      return perFile.flat();
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
};
