import { executeJs, executeTs, executeCode } from '../lib/sandbox/index.js';

describe('Sandbox', () => {
  describe('sync execution', () => {
    it('returns a simple value', async () => {
      const result = await executeJs('return 42');
      expect(result.success).toBe(true);
      expect(result.result).toBe('42');
    });

    it('returns string values', async () => {
      const result = await executeJs('return "hello"');
      expect(result.success).toBe(true);
      expect(result.result).toBe('"hello"');
    });

    it('returns object values', async () => {
      const result = await executeJs('return { a: 1, b: 2 }');
      expect(result.success).toBe(true);
      expect(JSON.parse(result.result!)).toEqual({ a: 1, b: 2 });
    });

    it('returns undefined when no return', async () => {
      const result = await executeJs('const x = 1');
      expect(result.success).toBe(true);
      expect(result.result).toBeUndefined();
    });

    it('captures console.log output', async () => {
      const result = await executeJs('console.log("hello"); console.warn("warn!"); return 1');
      expect(result.success).toBe(true);
      expect(result.logs).toHaveLength(2);
      expect(result.logs[0].level).toBe('log');
      expect(result.logs[0].args).toEqual(['hello']);
      expect(result.logs[1].level).toBe('warn');
      expect(result.logsFormatted).toContain('[LOG] hello');
      expect(result.logsFormatted).toContain('[WARN] warn!');
    });

    it('reports runtime errors', async () => {
      const result = await executeJs('throw new Error("boom")');
      expect(result.success).toBe(false);
      expect(result.error).toContain('boom');
    });

    it('reports reference errors', async () => {
      const result = await executeJs('return nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('nonexistent');
    });

    it('times out on sync infinite loops', async () => {
      const result = await executeJs('while(true) {}', { timeout: 200 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('has access to standard globals', async () => {
      const result = await executeJs(`
        const arr = [3, 1, 2];
        arr.sort();
        const map = new Map();
        map.set('a', 1);
        const url = new URL('https://example.com/path');
        return {
          sorted: arr,
          mapSize: map.size,
          hostname: url.hostname,
          encoded: btoa('hello'),
          hash: typeof crypto.createHash,
        }
      `);
      expect(result.success).toBe(true);
      const value = JSON.parse(result.result!);
      expect(value.sorted).toEqual([1, 2, 3]);
      expect(value.mapSize).toBe(1);
      expect(value.hostname).toBe('example.com');
      expect(value.encoded).toBe('aGVsbG8=');
      expect(value.hash).toBe('function');
    });

    it('measures execution time', async () => {
      const result = await executeJs('return 1');
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.executionTimeMs).toBeLessThan(5000);
    });
  });

  describe('async execution (await)', () => {
    it('supports top-level await with resolved promises', async () => {
      const result = await executeJs('const val = await Promise.resolve(42); return val');
      expect(result.success).toBe(true);
      expect(result.result).toBe('42');
    });

    it('supports await with promise chains', async () => {
      const result = await executeJs(`
        const a = await Promise.resolve(10);
        const b = await Promise.resolve(20);
        return a + b;
      `);
      expect(result.success).toBe(true);
      expect(result.result).toBe('30');
    });

    it('catches rejected promises', async () => {
      const result = await executeJs('await Promise.reject(new Error("async boom"))');
      expect(result.success).toBe(false);
      expect(result.error).toContain('async boom');
    });

    it('times out on slow async operations', async () => {
      const result = await executeJs(
        'await new Promise(resolve => {})', // never resolves
        { timeout: 300 },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('captures logs from async code', async () => {
      const result = await executeJs(`
        console.log("before");
        const val = await Promise.resolve("hello");
        console.log("after", val);
        return val;
      `);
      expect(result.success).toBe(true);
      expect(result.result).toBe('"hello"');
      expect(result.logs).toHaveLength(2);
      expect(result.logs[1].args).toEqual(['after', 'hello']);
    });
  });

  describe('fetch + domain restriction', () => {
    it('fetch is undefined when no domains allowed', async () => {
      const result = await executeCode('return typeof fetch', { allowedDomains: [] });
      expect(result.success).toBe(true);
      expect(result.result).toBe('"undefined"');
    });

    it('fetch is a function when domains are allowed', async () => {
      const result = await executeCode('return typeof fetch', {
        allowedDomains: ['example.com'],
      });
      expect(result.success).toBe(true);
      expect(result.result).toBe('"function"');
    });

    it('fetch rejects disallowed domains', async () => {
      const result = await executeCode(
        'try { await fetch("https://evil.com/x"); return "should not reach"; } catch(e) { return e.message; }',
        { allowedDomains: ['example.com'] },
      );
      expect(result.success).toBe(true);
      expect(result.result).toContain('evil.com');
      expect(result.result).toContain('not in the allowed domains');
    });

    it('fetch rejects invalid URLs', async () => {
      const result = await executeCode(
        'try { await fetch("not-a-url"); return "should not reach"; } catch(e) { return e.message; }',
        { allowedDomains: ['example.com'] },
      );
      expect(result.success).toBe(true);
      expect(result.result).toContain('Invalid URL');
    });

    it('Headers, Request, Response are available', async () => {
      const result = await executeCode(
        `
        return {
          headers: typeof Headers,
          request: typeof Request,
          response: typeof Response,
        }
      `,
        { allowedDomains: [] },
      );
      expect(result.success).toBe(true);
      const value = JSON.parse(result.result!);
      expect(value.headers).toBe('function');
      expect(value.request).toBe('function');
      expect(value.response).toBe('function');
    });

    it('fetch allows requests to allowed domains', async () => {
      // Use httpbin for a real HTTP test
      const result = await executeCode(
        `
        const res = await fetch("https://httpbin.org/get");
        return res.status;
      `,
        { allowedDomains: ['httpbin.org'], timeout: 10000 },
      );
      expect(result.success).toBe(true);
      expect(result.result).toBe('200');
    }, 15000);
  });

  describe('TypeScript execution', () => {
    it('compiles and runs TypeScript', async () => {
      const result = await executeTs(`
        const greet = (name: string): string => \`Hello, \${name}!\`;
        return greet("World");
      `);
      expect(result.success).toBe(true);
      expect(result.result).toBe('"Hello, World!"');
    });

    it('supports TypeScript interfaces and types', async () => {
      const result = await executeTs(`
        interface Point { x: number; y: number; }
        const p: Point = { x: 1, y: 2 };
        return p.x + p.y;
      `);
      expect(result.success).toBe(true);
      expect(result.result).toBe('3');
    });

    it('supports async/await in TypeScript', async () => {
      const result = await executeTs(`
        const getValue = async (): Promise<number> => {
          return await Promise.resolve(99);
        };
        return await getValue();
      `);
      expect(result.success).toBe(true);
      expect(result.result).toBe('99');
    });

    it('reports TypeScript compilation errors', async () => {
      // esbuild is lenient with types but catches syntax errors
      const result = await executeTs('const x: number = ;');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Compilation failed');
    });
  });

  describe('security', () => {
    it('blocks eval', async () => {
      const result = await executeJs('return eval("1 + 1")');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Code generation from strings disallowed');
    });

    it('blocks new Function', async () => {
      const result = await executeJs('return new Function("return 1")()');
      expect(result.success).toBe(false);
    });

    it('cannot access process', async () => {
      const result = await executeJs('return typeof process');
      expect(result.success).toBe(true);
      expect(result.result).toBe('"undefined"');
    });

    it('cannot access require', async () => {
      const result = await executeJs('return typeof require');
      expect(result.success).toBe(true);
      expect(result.result).toBe('"undefined"');
    });

    it('cannot access setTimeout', async () => {
      const result = await executeJs('return typeof setTimeout');
      expect(result.success).toBe(true);
      expect(result.result).toBe('"undefined"');
    });
  });
});
