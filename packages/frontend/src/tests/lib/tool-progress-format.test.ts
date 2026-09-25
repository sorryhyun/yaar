import { describe, expect, it } from 'bun:test';
import {
  errorStatusText,
  isAgentTool,
  isSubagentTool,
  runningStatusText,
  toolDisplayName,
  toolEntryContent,
  toolInputSummary,
} from '@/lib/transport/tool-progress-format';

const LONG = 'x'.repeat(100);

describe('tool classification', () => {
  it('treats the subagent tool and its prefixed progress tools as subagent', () => {
    expect(isSubagentTool('subagent')).toBe(true);
    expect(isSubagentTool('subagent:read')).toBe(true);
    expect(isSubagentTool('subagents')).toBe(false);
    expect(isSubagentTool('Agent')).toBe(false);
  });

  it('treats Claude Agent/Task invocations as agent tools', () => {
    expect(isAgentTool('Agent')).toBe(true);
    expect(isAgentTool('Task')).toBe(true);
    expect(isAgentTool('subagent')).toBe(false);
  });
});

describe('toolDisplayName', () => {
  it('turns the first colon of a subagent progress tool into an arrow', () => {
    expect(toolDisplayName('subagent:read')).toBe('subagent → read');
    expect(toolDisplayName('subagent:invoke:x')).toBe('subagent → invoke:x');
    expect(toolDisplayName('subagent')).toBe('subagent');
  });

  it('files Agent/Task under subagent and leaves other tools alone', () => {
    expect(toolDisplayName('Agent')).toBe('subagent');
    expect(toolDisplayName('Task')).toBe('subagent');
    expect(toolDisplayName('a:b')).toBe('a:b');
  });
});

describe('runningStatusText', () => {
  it('names a plain tool, whatever its input', () => {
    expect(runningStatusText('search', { description: 'd' })).toBe('Running: search');
  });

  it('falls back to the plain form for an agent tool with no input', () => {
    expect(runningStatusText('Agent', undefined)).toBe('Running: Agent');
    expect(runningStatusText('subagent', {})).toBe('Running: subagent');
  });

  it('shows an agent tool type and description, truncated at 60 characters', () => {
    expect(runningStatusText('Agent', { subagent_type: 'Explore', description: 'look' })).toBe(
      'Subagent (Explore): look',
    );
    expect(runningStatusText('Task', { subagent_type: 'Explore', prompt: LONG })).toBe(
      `Subagent (Explore): ${'x'.repeat(60)}...`,
    );
    expect(runningStatusText('Agent', { subagent_type: 'Explore' })).toBe('Subagent (Explore)');
  });

  it('prefers the URI over the description for a subagent progress tool', () => {
    expect(runningStatusText('subagent:read', { uri: 'yaar://x', description: 'd' })).toBe(
      'Subagent → read: yaar://x',
    );
    expect(runningStatusText('subagent:read', { description: 'd' })).toBe('Subagent → read: d');
    expect(runningStatusText('subagent:read', { other: 1 })).toBe('Subagent → read');
  });

  it('shows the description alone for an untyped subagent start', () => {
    expect(runningStatusText('subagent', { prompt: 'go' })).toBe('Subagent: go');
    expect(runningStatusText('Agent', { description: 'go' })).toBe('Subagent: go');
  });
});

describe('errorStatusText', () => {
  it('appends the error message, truncated at 80 characters', () => {
    expect(errorStatusText('search', 'boom')).toBe('Error: search — boom');
    expect(errorStatusText('search', LONG)).toBe(`Error: search — ${'x'.repeat(80)}`);
  });

  it('omits the separator when there is no message', () => {
    expect(errorStatusText('search', undefined)).toBe('Error: search');
    expect(errorStatusText('search', '')).toBe('Error: search');
  });
});

describe('toolInputSummary', () => {
  it('shows an agent tool type and full prompt', () => {
    expect(toolInputSummary('Agent', { subagent_type: 'Explore', prompt: LONG })).toBe(
      `(Explore) ${LONG}`,
    );
    expect(toolInputSummary('Task', { description: 'd' })).toBe('d');
    expect(toolInputSummary('Agent', { other: 1 })).toBe('{"other":1}');
  });

  it('shows a subagent URI with its payload action', () => {
    expect(
      toolInputSummary('subagent:invoke', { uri: 'yaar://x', payload: { action: 'open' } }),
    ).toBe('yaar://x (open)');
    expect(toolInputSummary('subagent:read', { uri: 'yaar://x', description: 'd' })).toBe(
      'yaar://x',
    );
    expect(toolInputSummary('subagent', { description: 'd', prompt: 'p' })).toBe('d');
    expect(toolInputSummary('subagent', { other: 1 })).toBe('{"other":1}');
  });

  it('passes a plain tool string through and serializes anything else', () => {
    expect(toolInputSummary('command', 'ls -la')).toBe('ls -la');
    expect(toolInputSummary('command', { cmd: 'ls' })).toBe('{"cmd":"ls"}');
  });
});

describe('toolEntryContent', () => {
  it('files a running call with input under its display name', () => {
    expect(toolEntryContent('subagent:read', 'running', { uri: 'yaar://x' })).toBe(
      '[subagent → read] yaar://x',
    );
    expect(toolEntryContent('Agent', 'running', { prompt: 'p' })).toBe('[subagent] p');
  });

  it('falls back to the status word without input, and always for an error', () => {
    expect(toolEntryContent('search', 'running', undefined)).toBe('[search] running');
    expect(toolEntryContent('search', 'error', { q: 1 })).toBe('[search] error');
  });
});
