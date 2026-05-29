import { describe, it, expect, afterAll } from 'bun:test';
import { ResourceRegistry, setAccessRoleResolver } from '../handlers/uri-registry.js';
import type { ResourceHandler } from '../handlers/uri-registry.js';
import type { AgentRole } from '../agents/agent-context.js';

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
      const h = mockHandler();
      reg.register('yaar://config/*', h);

      expect(reg.findHandler('yaar://config/settings')).toBe(h);
      expect(reg.findHandler('yaar://config')).toBe(h);
      expect(reg.findHandler('yaar://storage/file')).toBeNull();
    });

    it('exact wins over prefix and wildcard', () => {
      const reg = new ResourceRegistry();
      const exact = mockHandler({ description: 'exact' });
      const prefix = mockHandler({ description: 'prefix' });
      const wildcard = mockHandler({ description: 'wildcard' });

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

  describe('session-principal access control', () => {
    // Drive the injected resolver directly (production wires it to the ALS-backed
    // getAgentRole; the gate just calls resolveAgentRole()).
    let currentRole: AgentRole | undefined;
    setAccessRoleResolver(() => currentRole);
    afterAll(() => setAccessRoleResolver(() => undefined));

    // Gate is handler-keyed (namespace-agnostic); use a resolvable URI.
    const URI = 'yaar://config/settings';
    function sessionReg() {
      const reg = new ResourceRegistry();
      reg.register(URI, mockHandler({ access: 'session-principal', description: 'session-only' }));
      return reg;
    }

    it('denies callers with no role (default-deny)', async () => {
      currentRole = undefined;
      const r = await sessionReg().execute('read', URI);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('Access denied');
    });

    it('denies monitor- and app-tier callers', async () => {
      const reg = sessionReg();
      for (const role of ['monitor', 'app'] as const) {
        currentRole = role;
        const r = await reg.execute('read', URI);
        expect(r.isError).toBe(true);
        expect(text(r)).toContain('Access denied');
      }
    });

    it('allows the session agent', async () => {
      currentRole = 'session';
      const r = await sessionReg().execute('read', URI);
      expect(r.isError).toBeUndefined();
      expect(text(r)).toBe('read-ok');
    });

    it('does not gate handlers without an access requirement', async () => {
      currentRole = 'monitor';
      const reg = new ResourceRegistry();
      reg.register('yaar://config/settings', mockHandler());
      const r = await reg.execute('read', 'yaar://config/settings');
      expect(r.isError).toBeUndefined();
      expect(text(r)).toBe('read-ok');
    });
  });
});
