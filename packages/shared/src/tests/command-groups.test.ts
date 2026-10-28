/**
 * Command group keys (`files/edit`) — the shared rules both protocol readers and every
 * server door read the same way.
 */
import { describe, expect, test } from 'bun:test';
import { commandGroupOf, groupCommandKeys, listCommandKeyIssues } from '../app-protocol.js';

describe('commandGroupOf', () => {
  test('the segment before the slash, or nothing', () => {
    expect(commandGroupOf('files/edit')).toBe('files');
    expect(commandGroupOf('ping')).toBeUndefined();
    expect(commandGroupOf('persona:report')).toBeUndefined();
  });
});

describe('groupCommandKeys', () => {
  test('groups and the ungrouped rest, each in declaration order', () => {
    const { groups, ungrouped } = groupCommandKeys([
      'files/edit',
      'ping',
      'build/compile',
      'files/read',
    ]);
    expect([...groups]).toEqual([
      ['files', ['files/edit', 'files/read']],
      ['build', ['build/compile']],
    ]);
    expect(ungrouped).toEqual(['ping']);
  });

  test('a flat app has no groups', () => {
    expect(groupCommandKeys(['a', 'b']).groups.size).toBe(0);
  });
});

describe('listCommandKeyIssues', () => {
  test('valid keys pass', () => {
    expect(listCommandKeyIssues(['files/edit', 'files/read', 'ping', 'persona:x'])).toEqual([]);
  });

  test('one level deep, a name on both sides', () => {
    const issues = listCommandKeyIssues(['a/b/c', '/edit', 'files/']);
    expect(issues.map((i) => i.command)).toEqual(['a/b/c', '/edit', 'files/']);
  });

  test('a group may not share its name with an ungrouped command', () => {
    const issues = listCommandKeyIssues(['preview', 'preview/eval', 'preview/query']);
    expect(issues.map((i) => i.command)).toEqual(['preview/eval', 'preview/query']);
    expect(issues[0].issue).toContain('rename one');
  });
});
