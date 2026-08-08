/**
 * The index form of a protocol — the summary rule and the rows built from it.
 *
 * These are the bytes that decide whether a 52-command app's `list` is 10 KB or 80 KB, so
 * the rule is worth pinning at the character level. Two properties matter more than the
 * rest: an author who front-loads a summary sentence gets that sentence *verbatim* (no
 * ellipsis, no reflow surprises), and a row never invents documentation for a command that
 * documents nothing.
 */
import { describe, expect, test } from 'bun:test';
import {
  firstSentence,
  commandRow,
  commandLinkDescription,
  stateRow,
  descriptionOf,
  buildProtocolIndex,
  INDEX_SUMMARY_MAX,
} from '../lib/protocol-index.js';

describe('firstSentence', () => {
  test('a single short sentence is reproduced exactly, with no ellipsis', () => {
    const text = 'Remove every node and dispose all GPU resources.';
    expect(firstSentence(text)).toBe(text);
  });

  test('stops at the first sentence and drops the rest', () => {
    const summary = firstSentence(
      'Save the scene document as a .scene.json file. Overwrites silently. Returns the path.',
    );
    expect(summary).toBe('Save the scene document as a .scene.json file.');
  });

  test('an abbreviation is not mistaken for the end of a sentence', () => {
    // The naive rule cuts at "e.g." and yields four characters of documentation.
    const summary = firstSentence(
      'Applies a boolean operation, e.g. union or subtract, to the two selected meshes. More detail follows.',
    );
    expect(summary).toBe(
      'Applies a boolean operation, e.g. union or subtract, to the two selected meshes.',
    );
  });

  test('a paragraph break ends the summary even without punctuation', () => {
    expect(firstSentence('Load a model\n\nThen do other things.')).toBe('Load a model');
  });

  test('wrapping inside one paragraph collapses to a single line', () => {
    expect(firstSentence('Load a model\n   from a URI.')).toBe('Load a model from a URI.');
  });

  test('over the cap it truncates on a word boundary and says so', () => {
    const long = `${'alpha beta gamma delta '.repeat(40)}end.`;
    const summary = firstSentence(long);
    expect(summary.length).toBeLessThanOrEqual(INDEX_SUMMARY_MAX + 1);
    expect(summary.endsWith('…')).toBe(true);

    // The kept text is a prefix of the original, and it stopped at a word boundary —
    // an ellipsis landing mid-identifier is how a truncated summary becomes a wrong one.
    const kept = summary.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(' ');
  });

  test('a short opening sentence is kept, not skipped in search of a longer one', () => {
    // The abbreviation guard keys on the token before the period, not on how much text
    // precedes it — a length floor would swallow the second sentence here.
    expect(firstSentence('Move a node. Undo records one step.')).toBe('Move a node.');
  });

  test('a missing or non-string description is empty, not "undefined"', () => {
    expect(firstSentence(undefined)).toBe('');
    expect(firstSentence({ nope: true })).toBe('');
    expect(firstSentence('   ')).toBe('');
  });
});

describe('descriptionOf', () => {
  test('reads a descriptor and a bare string alike', () => {
    expect(descriptionOf({ description: 'A thing.' })).toBe('A thing.');
    expect(descriptionOf('A thing.')).toBe('A thing.');
    expect(descriptionOf({})).toBe('');
  });
});

describe('index rows', () => {
  const DEFS = {
    vec3: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['x', 'y', 'z'],
    },
  };

  test('a command row is its signature and its opening sentence', () => {
    const descriptor = {
      description: 'Move a node to a point. Undo history records one step.',
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, to: { $ref: '#/$defs/vec3' } },
        required: ['id', 'to'],
      },
    };
    expect(commandRow('moveNode', descriptor, DEFS)).toBe(
      'moveNode(id: string, to: object) — Move a node to a point.',
    );
    // The `$ref` resolved: without the defs table it would have rendered as `any`.
    expect(commandRow('moveNode', descriptor)).toContain('to: any');
  });

  test('a command that declares no params renders as a bare name, not `name()`', () => {
    // `name()` would document an *empty* parameter list, which is a different claim from
    // "this command documents no parameter list".
    expect(commandRow('clearScene', { description: 'Remove every node.' })).toBe(
      'clearScene — Remove every node.',
    );
  });

  test('a command that documents nothing gets no invented prose', () => {
    expect(commandRow('mystery', {})).toBe('mystery');
    expect(stateRow('selection', {})).toBe('selection');
  });

  test('a link row drops the bare name its `name` field already carries', () => {
    // A `resource_link` named `commands/openPath` does not need "openPath — " prefixed to
    // its description. A real signature is never redundant, so it stays.
    expect(commandLinkDescription('openPath', { description: 'Open a path.' })).toBe(
      'Open a path.',
    );
    expect(commandLinkDescription('mystery', {})).toBe('');
    expect(
      commandLinkDescription('moveNode', {
        description: 'Move it.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      }),
    ).toBe('moveNode(id: string) — Move it.');
  });

  test('the whole protocol indexes to one row per entry', () => {
    const index = buildProtocolIndex(
      {
        state: { selection: { description: 'Selected ids.' } },
        commands: { a: { description: 'Does A.' }, b: { description: 'Does B.' } },
      },
      undefined,
    );
    expect(index.state).toEqual(['selection — Selected ids.']);
    expect(index.commands).toEqual(['a — Does A.', 'b — Does B.']);
  });

  test('an empty protocol indexes to empty lists rather than throwing', () => {
    expect(buildProtocolIndex(undefined)).toEqual({ state: [], commands: [] });
  });
});
