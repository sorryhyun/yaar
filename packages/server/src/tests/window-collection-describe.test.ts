/**
 * `describe` on the window collection must reach the window manual.
 *
 * The registry folds `yaar://windows/` onto the exact `yaar://windows` handler for any verb
 * that handler declares, so the collection branch of the window handler's `describe` — the
 * only place `create`'s schema is published — was unreachable: both spellings answered with
 * the list handler's auto-generated "list the open windows", verbs `describe`/`list`.
 */
import { describe, it, expect } from 'bun:test';
import type { WindowStateRegistry } from '../session/window-state.js';

const { ResourceRegistry } = await import('../handlers/uri-registry.js');
const { registerWindowHandlers } = await import('../handlers/window.js');

function registry() {
  const r = new ResourceRegistry();
  const empty = { stackOrder: () => [], getFocusedWindowId: () => undefined };
  registerWindowHandlers(r, () => empty as unknown as WindowStateRegistry);
  return r;
}

describe('yaar://windows collection describe', () => {
  for (const uri of ['yaar://windows', 'yaar://windows/']) {
    it(`${uri} publishes the invoke schema, create included`, async () => {
      const result = await registry().execute('describe', uri);
      expect(result.isError).toBeUndefined();
      const doc = JSON.parse((result.content[0] as { text: string }).text);
      expect(doc.uri).toBe('yaar://windows/');
      expect(doc.verbs).toContain('invoke');
      expect(doc.invokeSchema.properties.action.enum).toContain('create');
    });
  }

  it('list on the collection still lists windows', async () => {
    const result = await registry().execute('list', 'yaar://windows/');
    expect(result.isError).toBeUndefined();
  });
});
