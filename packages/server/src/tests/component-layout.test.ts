/**
 * An inline component layout is validated like a `.yaarcomponent.json` one.
 *
 * `create` used to cast `content.components` straight into the action, so a layout using
 * types the DSL lacks — `{ type: "markdown" }`, a `{ type: "row", components: [...] }`
 * container — reported "Created component window" and painted `unsupported: <type>`
 * placeholders. The agent had no signal until the user said the window looked broken
 * (GitHub issue #173). See features/window/component-layout.ts.
 */
import { describe, it, expect } from 'bun:test';
import { COMPONENT_TYPES } from '@yaar/shared';
import { runWithAgentContext } from '../agents/agent-context.js';
import { actionEmitter, type ActionEvent } from '../session/action-emitter.js';
import { handleCreate } from '../features/window/create.js';
import { parseComponentLayout } from '../features/window/component-layout.js';
import { TOPICS } from '../features/skills/topics.js';
import type { SessionId } from '../session/types.js';

async function create(payload: Record<string, unknown>) {
  const seen: ActionEvent[] = [];
  const listen = (e: ActionEvent) => seen.push(e);
  actionEmitter.on('action', listen);
  try {
    const result = await runWithAgentContext(
      {
        agentId: 'agent-m0',
        sessionId: 'test-session' as SessionId,
        monitorId: '0',
        role: 'monitor',
      },
      () => handleCreate('', payload),
    );
    return { result, action: seen.at(-1)?.action };
  } finally {
    actionEmitter.off('action', listen);
  }
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('handleCreate with renderer "component"', () => {
  it('refuses the reported layout and names each unknown type (issue #173)', async () => {
    const { result, action } = await create({
      title: 't',
      renderer: 'component',
      content: {
        components: [
          { type: 'markdown', content: '## Hello' },
          {
            type: 'row',
            components: [
              { type: 'button', label: 'A', action: 'a' },
              { type: 'button', label: 'B', action: 'b' },
            ],
          },
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(action).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('components[0]: type "markdown"');
    expect(text).toContain('renderer: "markdown"');
    expect(text).toContain('components[1]: type "row" (containers are not supported)');
    expect(text).toContain(COMPONENT_TYPES.join(', '));
  });

  it('still opens a valid layout, with the schema-coerced cols', async () => {
    const { result, action } = await create({
      title: 'ok',
      renderer: 'component',
      content: {
        cols: '[7,3]',
        components: [
          { type: 'text', content: 'Name' },
          { type: 'button', label: 'Go', action: 'go' },
        ],
      },
    });
    expect(result.isError).toBeUndefined();
    expect(action).toMatchObject({
      type: 'window.create',
      content: { renderer: 'component', data: { cols: [7, 3] } },
    });
  });
});

describe('parseComponentLayout', () => {
  it('reports a bad prop value by its path', () => {
    const r = parseComponentLayout({ components: [{ type: 'progress', value: 150 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('components[0].value');
  });

  it('refuses a missing or non-array components field', () => {
    expect(parseComponentLayout({}).ok).toBe(false);
    expect(parseComponentLayout({ components: 'nope' }).ok).toBe(false);
    expect(parseComponentLayout('{"components":[]}').ok).toBe(false);
  });

  it('flags an entry with no type at all', () => {
    const r = parseComponentLayout({ components: [{ label: 'x' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('components[0]: no type');
  });
});

describe('yaar://skills/components', () => {
  it('documents every component type the schema admits', () => {
    // The table is hand-written; this keeps it from falling behind COMPONENT_TYPES.
    for (const type of COMPONENT_TYPES) {
      expect(TOPICS.components).toContain(`| \`${type}\` |`);
    }
  });
});
