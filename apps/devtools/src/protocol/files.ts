import { AppCommandError, errMsg, defineAppCommand } from '@bundled/yaar';
import { activeProject } from '../core';
import { isImagePath, type EditSpec } from '../lib';
import {
  openFile,
  writeFile,
  editFile,
  deleteFile,
  copyFile,
  grep,
  readFileContent,
  readImageFile,
} from '../services';

import { getMimeType, imageBlocks, type ReadBlock } from './read-blocks';

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

export const fileCommands = {
  readFile: defineAppCommand({
    description:
      'Read one or more files. Does not change editor open state unless openInEditor is set. ' +
      'Image files come back as a viewable image block, not text.',
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
        lineNum: {
          type: 'boolean',
          description: 'Prefix each line with its number. Default false.',
        },
        openInEditor: { type: 'boolean', description: 'Also open file(s) in editor UI' },
      },
      required: ['path'],
    },
    run: async (p) => {
      const rawPath = p.path;
      const paths: string[] = Array.isArray(rawPath) ? rawPath.map(String) : [String(rawPath)];
      const opts = {
        startLine: p.startLine != null ? Number(p.startLine) : undefined,
        endLine: p.endLine != null ? Number(p.endLine) : undefined,
        lineNum: Boolean(p.lineNum),
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
            if (image) return imageBlocks(fp, [image]);
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
  writeFile: defineAppCommand({
    description:
      'Write content to a file. Content may be a string, an array of lines (joined with "\\n", ' +
      'no trailing newline added), or an object (serialized as pretty-printed JSON). Prefer the ' +
      'array form for anything longer than a few lines: one line per element keeps each JSON ' +
      'string short and avoids the long escaped-newline blob that has been arriving truncated. ' +
      'Returns { path, lines, bytes } for what landed — check it when you passed an object, since ' +
      'that is where the serialization can surprise you.',
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
    run: async (p) => {
      // `String(content)` turned an object into the literal "[object Object]" and wrote that
      // to disk — silent corruption, and passing an object is the natural thing to do for
      // app.json. Mirrors copyFile/readFileContent, which already guard this way.
      const content = Array.isArray(p.content) ? joinLines(p.content) : serialize(p.content);
      return await writeFile(String(p.path), content);
    },
  }),
  editFile: defineAppCommand({
    description:
      'Edit a file in place. Three modes: (1) search/replace — pass search + replace, first ' +
      'match only. (2) line range — pass startLine/endLine (1-based, inclusive) and anchor ' +
      '(REQUIRED: current text of startLine, compared trimmed; mismatch rejects the edit and ' +
      'writes nothing) with optional replace; omit replace to delete the range. ' +
      '(3) multi-edit — pass edits, an array of single-edit objects, applied sequentially in ' +
      'memory and written once, all-or-nothing: any failure names which edit failed, counting ' +
      'from 1 ("edit 2 of 3"), and nothing is written; later line numbers refer to content ' +
      'after earlier edits. `oldString`/`newString` are accepted as aliases for ' +
      'search/replace, in every mode. Returns ' +
      '{ editsApplied, lines, removed } — removed echoes the replaced text (truncated, middle elided).',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        search: {
          type: 'string',
          description: 'Text to find (first match). Mutually exclusive with startLine/endLine.',
        },
        replace: {
          type: 'string',
          description:
            'Replacement text. With startLine/endLine, omit or pass an empty string to delete the range.',
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
              search: { type: 'string' },
              replace: { type: 'string' },
              startLine: { type: 'number' },
              endLine: { type: 'number' },
              anchor: { type: 'string', description: 'Required with startLine/endLine.' },
            },
          },
        },
      },
      required: ['path'],
    },
    run: async (p) => {
      const normalize = (e: {
        search?: string;
        replace?: string;
        oldString?: string;
        newString?: string;
        startLine?: number;
        endLine?: number;
        anchor?: string;
      }): EditSpec => {
        const search = e.search ?? e.oldString;
        const replace = e.replace ?? e.newString;
        return {
          ...(search !== undefined ? { search: String(search) } : {}),
          ...(replace !== undefined ? { replace: String(replace) } : {}),
          ...(e.startLine !== undefined ? { startLine: Number(e.startLine) } : {}),
          ...(e.endLine !== undefined ? { endLine: Number(e.endLine) } : {}),
          ...(e.anchor !== undefined ? { anchor: String(e.anchor) } : {}),
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
  deleteFile: defineAppCommand({
    description: 'Delete a file',
    params: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    run: async (p) => {
      await deleteFile(String(p.path));
    },
  }),
  copyFile: defineAppCommand({
    description:
      'Copy a file to another path within the active project; destination directories are ' +
      'created automatically. Does NOT delete the original — pair with deleteFile to move.',
    params: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source file path (e.g. "src/Foo.ts")' },
        to: { type: 'string', description: 'Destination file path (e.g. "src/ui/Foo.ts")' },
      },
      required: ['from', 'to'],
    },
    run: async (p) => {
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
  grep: defineAppCommand({
    description: 'Search file contents with regex across the project',
    params: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        glob: { type: 'string', description: 'File glob filter (e.g. "src/**/*.ts")' },
      },
      required: ['pattern'],
    },
    run: async (p) => {
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
