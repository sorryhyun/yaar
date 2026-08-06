import { describe, it, expect } from 'bun:test';
import { ResourceRegistry, setAccessPrincipalResolver } from '../handlers/uri-registry.js';
import type { ResourceHandler } from '../handlers/uri-registry.js';
import {
  getAccessPrincipal,
  runWithAgentContext,
  type AccessPrincipal,
} from '../agents/agent-context.js';

/**
 * Wire the gate the way lifecycle.ts does, and drive it through the same
 * AsyncLocalStorage a real caller travels in.
 *
 * A fake resolver would read more directly, but the resolver is process-global and the
 * unit partition runs its files *concurrently* in one process — so a file that installs
 * its own would decide the gate's answer for every other file that happens to overlap
 * it. Installing the production resolver is idempotent: session-principal.test.ts does
 * the same, and whichever order they load in, they agree.
 */
setAccessPrincipalResolver(getAccessPrincipal);

/** Run `fn` as a caller with this principal, as the two doors would enter it. */
function as<T>(principal: AccessPrincipal, fn: () => T): T {
  return runWithAgentContext({ agentId: 'test-caller', ...principal }, fn);
}

/** Extract text from first content item (all test results are text). */
const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  (r.content[0] as { type: 'text'; text: string }).text;

function mockHandler(overrides: Partial<ResourceHandler> = {}): ResourceHandler {
  return {
    description: 'test handler',
    verbs: ['describe', 'read'],
    async read() {
      return { content: [{ type: 'text', text: 'read-ok' }] };
    },
    ...overrides,
  };
}

/**
 * A wildcard pattern must say how to tell whether its id names anything — see
 * `ResourceRegistry.register`. These tests are about matching, not existence, so
 * they answer "yes" and move on.
 */
function wildcardHandler(overrides: Partial<ResourceHandler> = {}): ResourceHandler {
  return mockHandler({
    async exists() {
      return true;
    },
    ...overrides,
  });
}

describe('ResourceRegistry', () => {
  describe('pattern matching', () => {
    it('matches exact patterns', () => {
      const reg = new ResourceRegistry();
      const h = mockHandler();
      reg.register('yaar://config/settings', h);

      expect(reg.findHandler('yaar://config/settings')).toBe(h);
      expect(reg.findHandler('yaar://config/hooks')).toBeNull();
    });

    it('matches prefix patterns', () => {
      const reg = new ResourceRegistry();
      const h = mockHandler();
      reg.register('yaar://config/', h);

      expect(reg.findHandler('yaar://config/settings')).toBe(h);
      expect(reg.findHandler('yaar://config/hooks')).toBe(h);
      expect(reg.findHandler('yaar://config')).toBe(h);
      expect(reg.findHandler('yaar://storage/file')).toBeNull();
    });

    it('matches wildcard patterns', () => {
      const reg = new ResourceRegistry();
      const h = wildcardHandler();
      reg.register('yaar://config/*', h);

      expect(reg.findHandler('yaar://config/settings')).toBe(h);
      expect(reg.findHandler('yaar://config')).toBe(h);
      expect(reg.findHandler('yaar://storage/file')).toBeNull();
    });

    it('exact wins over prefix and wildcard', () => {
      const reg = new ResourceRegistry();
      const exact = mockHandler({ description: 'exact' });
      const prefix = mockHandler({ description: 'prefix' });
      const wildcard = wildcardHandler({ description: 'wildcard' });

      reg.register('yaar://config/*', wildcard);
      reg.register('yaar://config/', prefix);
      reg.register('yaar://config/settings', exact);

      expect(reg.findHandler('yaar://config/settings')).toBe(exact);
      // Non-exact falls to prefix (higher priority than wildcard)
      expect(reg.findHandler('yaar://config/hooks')).toBe(prefix);
    });

    it('longer prefix wins over shorter prefix', () => {
      const reg = new ResourceRegistry();
      const short = mockHandler({ description: 'short' });
      const long = mockHandler({ description: 'long' });

      reg.register('yaar://config/', short);
      reg.register('yaar://config/app/', long);

      expect(reg.findHandler('yaar://config/app/github')).toBe(long);
      expect(reg.findHandler('yaar://config/settings')).toBe(short);
    });
  });

  describe('execute', () => {
    it('auto-generates describe responses', async () => {
      const reg = new ResourceRegistry();
      reg.register(
        'yaar://config/settings',
        mockHandler({
          description: 'User settings',
          verbs: ['describe', 'read', 'invoke'],
          invokeSchema: { type: 'object', properties: { theme: { type: 'string' } } },
        }),
      );

      const result = await reg.execute('describe', 'yaar://config/settings');
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(text(result));
      expect(body.description).toBe('User settings');
      expect(body.verbs).toContain('read');
      expect(body.verbs).toContain('invoke');
      expect(body.invokeSchema).toBeDefined();
    });

    it('returns error for unsupported verb', async () => {
      const reg = new ResourceRegistry();
      reg.register(
        'yaar://config/settings',
        mockHandler({
          verbs: ['describe', 'read'],
        }),
      );

      const result = await reg.execute('delete', 'yaar://config/settings');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('not supported');
    });

    it('returns error for unregistered URI', async () => {
      const reg = new ResourceRegistry();
      const result = await reg.execute('read', 'yaar://unknown/resource');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('No handler');
    });

    it('delegates read to handler', async () => {
      const reg = new ResourceRegistry();
      reg.register(
        'yaar://config/settings',
        mockHandler({
          verbs: ['describe', 'read'],
          async read() {
            return { content: [{ type: 'text', text: '{"theme":"dark"}' }] };
          },
        }),
      );

      const result = await reg.execute('read', 'yaar://config/settings');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toBe('{"theme":"dark"}');
    });

    it('passes payload to invoke', async () => {
      const reg = new ResourceRegistry();
      let receivedPayload: Record<string, unknown> | undefined;
      reg.register(
        'yaar://config/settings',
        mockHandler({
          verbs: ['describe', 'invoke'],
          async invoke(_resolved, payload) {
            receivedPayload = payload;
            return { content: [{ type: 'text', text: 'invoked' }] };
          },
        }),
      );

      await reg.execute('invoke', 'yaar://config/settings', { theme: 'light' });
      expect(receivedPayload).toEqual({ theme: 'light' });
    });
  });

  // The auto-generated describe answers about the URI *pattern*, so without this hook it
  // is byte-identical for a live resource and one that has never existed.
  describe('exists()', () => {
    it('refuses to register a wildcard that declares neither exists nor describe', () => {
      const reg = new ResourceRegistry();
      expect(() => reg.register('yaar://config/*', mockHandler())).toThrow(
        /exists\(\) or describe/,
      );
    });

    it('accepts a wildcard that declares describe instead', () => {
      const reg = new ResourceRegistry();
      expect(() =>
        reg.register(
          'yaar://config/*',
          mockHandler({
            async describe() {
              return { content: [{ type: 'text', text: 'custom' }] };
            },
          }),
        ),
      ).not.toThrow();
    });

    it('errors on describe when the resource does not exist', async () => {
      const reg = new ResourceRegistry();
      reg.register(
        'yaar://config/*',
        wildcardHandler({
          async exists(resolved) {
            return resolved.sourceUri === 'yaar://config/hooks/real';
          },
        }),
      );

      const missing = await reg.execute('describe', 'yaar://config/hooks/ghost');
      expect(missing.isError).toBe(true);
      expect(text(missing)).toContain('No resource at yaar://config/hooks/ghost');

      const present = await reg.execute('describe', 'yaar://config/hooks/real');
      expect(present.isError).toBeFalsy();
      expect(JSON.parse(text(present)).uri).toBe('yaar://config/hooks/real');
    });

    it('is not consulted when the handler owns its own describe', async () => {
      const reg = new ResourceRegistry();
      let asked = false;
      reg.register(
        'yaar://config/*',
        mockHandler({
          async exists() {
            asked = true;
            return false;
          },
          async describe() {
            return { content: [{ type: 'text', text: 'mine' }] };
          },
        }),
      );

      const r = await reg.execute('describe', 'yaar://config/hooks/anything');
      expect(text(r)).toBe('mine');
      expect(asked).toBe(false);
    });

    it('does not gate verbs other than describe', async () => {
      const reg = new ResourceRegistry();
      reg.register(
        'yaar://config/*',
        wildcardHandler({
          async exists() {
            return false;
          },
        }),
      );

      // read still reaches the handler, which reports absence in its own words —
      // `exists` exists to stop describe from inventing a success, not to become a
      // second permission layer in front of every verb.
      const r = await reg.execute('read', 'yaar://config/hooks/ghost');
      expect(text(r)).toBe('read-ok');
    });
  });

  describe('session-principal access control', () => {
    // Gate is handler-keyed (namespace-agnostic); use a resolvable URI.
    const URI = 'yaar://config/settings';
    function sessionReg() {
      const reg = new ResourceRegistry();
      reg.register(URI, mockHandler({ access: 'session-principal', description: 'session-only' }));
      return reg;
    }

    it('denies callers with no principal (default-deny)', async () => {
      const r = await sessionReg().execute('read', URI);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('Access denied');
    });

    it('denies monitor- and app-tier callers', async () => {
      const reg = sessionReg();
      for (const role of ['monitor', 'app'] as const) {
        const r = await as({ role }, () => reg.execute('read', URI));
        expect(r.isError).toBe(true);
        expect(text(r)).toContain('Access denied');
      }
    });

    it('allows the session agent', async () => {
      const r = await as({ role: 'session' }, () => sessionReg().execute('read', URI));
      expect(r.isError).toBeUndefined();
      expect(text(r)).toBe('read-ok');
    });

    // A bundled system app's iframe has no agent role at all — it is not an agent. The
    // HTTP gate has always let it reach yaar://session/*; this is the same rule stated
    // at the authoritative gate, so both doors now answer alike.
    it('allows a token-backed system app, which carries no role', async () => {
      const r = await as({ systemApp: true }, () => sessionReg().execute('read', URI));
      expect(r.isError).toBeUndefined();
      expect(text(r)).toBe('read-ok');
    });

    it('denies an app-tier caller that is not a system app', async () => {
      const r = await as({ role: 'app', systemApp: false }, () =>
        sessionReg().execute('read', URI),
      );
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('Access denied');
    });

    it('does not gate handlers without an access requirement', async () => {
      const reg = new ResourceRegistry();
      reg.register('yaar://config/settings', mockHandler());
      const r = await as({ role: 'monitor' }, () => reg.execute('read', 'yaar://config/settings'));
      expect(r.isError).toBeUndefined();
      expect(text(r)).toBe('read-ok');
    });
  });
});
