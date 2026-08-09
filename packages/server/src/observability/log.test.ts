import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  createLogger,
  configureLogging,
  isLevelEnabled,
  setLogContextResolver,
  resetLogContextResolver,
} from './log.js';

/**
 * Captured stdout / stderr lines, kept apart so routing is assertable.
 *
 * `warn` and `error` are captured separately as well: a caller that spies on `console.warn`
 * alone (several test helpers in this repo do) must still see warnings.
 */
let out: string[] = [];
let err: string[] = [];
let warnOnly: string[] = [];
let debugOnly: string[] = [];
const real = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  debug: console.debug,
};

beforeEach(() => {
  out = [];
  err = [];
  warnOnly = [];
  debugOnly = [];
  console.log = (...args: unknown[]) => void out.push(args.join(' '));
  console.debug = (...args: unknown[]) => {
    out.push(args.join(' '));
    debugOnly.push(args.join(' '));
  };
  console.error = (...args: unknown[]) => void err.push(args.join(' '));
  console.warn = (...args: unknown[]) => {
    err.push(args.join(' '));
    warnOnly.push(args.join(' '));
  };
  configureLogging({ level: 'info', format: 'pretty' });
  resetLogContextResolver();
});

afterEach(() => {
  console.log = real.log;
  console.error = real.error;
  console.warn = real.warn;
  console.debug = real.debug;
  resetLogContextResolver();
});

describe('pretty format', () => {
  test('reads like the [Component] message it replaced', () => {
    createLogger('AgentSession').info('turn started');
    expect(out).toEqual(['[AgentSession] turn started']);
  });

  test('appends fields as key=value', () => {
    createLogger('AgentPool').info('agent created', { role: 'monitor', slots: 3 });
    expect(out[0]).toBe('[AgentPool] agent created  role=monitor slots=3');
  });

  test('carries only monitor and agent ids — a full session id per line is unreadable', () => {
    setLogContextResolver(() => ({
      sessionId: 'sess-long-abcdef',
      monitorId: '0',
      agentId: 'monitor-0',
      windowId: 'w1',
    }));
    createLogger('ContextPool').info('task queued');
    expect(out[0]).toBe('[ContextPool] task queued  m=0 a=monitor-0');
  });
});

describe('json format', () => {
  test('carries every context id and a timestamp', () => {
    configureLogging({ format: 'json' });
    setLogContextResolver(() => ({
      sessionId: 's1',
      monitorId: '0',
      agentId: 'a1',
      windowId: 'w1',
      appId: 'notes',
    }));
    createLogger('ContextPool').info('task queued', { kind: 'user' });

    const line = JSON.parse(out[0]);
    expect(line).toMatchObject({
      level: 'info',
      component: 'ContextPool',
      message: 'task queued',
      sessionId: 's1',
      monitorId: '0',
      agentId: 'a1',
      windowId: 'w1',
      appId: 'notes',
      kind: 'user',
    });
    expect(new Date(line.ts).toISOString()).toBe(line.ts);
  });

  test('omits ids that are absent rather than emitting nulls', () => {
    configureLogging({ format: 'json' });
    createLogger('boot').info('started');
    const line = JSON.parse(out[0]);
    expect(line).not.toHaveProperty('sessionId');
    expect(line).not.toHaveProperty('agentId');
  });
});

describe('levels', () => {
  test('debug is silent by default', () => {
    createLogger('x').debug('noisy');
    expect(out).toEqual([]);
    expect(isLevelEnabled('debug')).toBe(false);
  });

  test('debug prints once asked for', () => {
    configureLogging({ level: 'debug' });
    createLogger('x').debug('noisy');
    expect(out).toEqual(['[x] noisy']);
  });

  test('a raised level silences everything under it', () => {
    configureLogging({ level: 'error' });
    const log = createLogger('x');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(out).toEqual([]);
    expect(err).toEqual(['[x] e']);
  });
});

describe('routing', () => {
  test('warn and error go to stderr, info to stdout', () => {
    const log = createLogger('x');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(out).toEqual(['[x] i']);
    expect(err).toEqual(['[x] w', '[x] e']);
  });

  test('a warning reaches console.warn, not only stderr', () => {
    // Routing warn through `console.error` puts it on the right stream and still makes
    // every `console.warn` spy in the suite observe nothing. Several tests depend on this.
    createLogger('x').warn('w');
    expect(warnOnly).toEqual(['[x] w']);
  });

  test('a debug line reaches console.debug', () => {
    configureLogging({ level: 'debug' });
    createLogger('x').debug('d');
    expect(debugOnly).toEqual(['[x] d']);
  });
});

describe('field rendering', () => {
  test('an Error logs its message, not JSON.stringify’s empty object', () => {
    createLogger('x').error('failed', { err: new Error('boom') });
    expect(err[0]).toBe('[x] failed  err=boom');
  });

  test('an Error in json mode keeps message and stack', () => {
    configureLogging({ format: 'json' });
    createLogger('x').error('failed', { err: new Error('boom') });
    const line = JSON.parse(err[0]);
    expect(line.err.message).toBe('boom');
    expect(line.err.stack).toContain('boom');
  });

  test('objects serialize, and an unserializable one does not throw', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    createLogger('x').info('v', { obj: { a: 1 }, cyclic });
    expect(out[0]).toBe('[x] v  obj={"a":1} cyclic=[unserializable]');
  });
});

describe('child loggers', () => {
  test('bound fields ride along on every call', () => {
    const log = createLogger('Provider').child({ provider: 'codex' });
    log.info('connected');
    log.warn('retrying', { attempt: 2 });
    expect(out[0]).toBe('[Provider] connected  provider=codex');
    expect(err[0]).toBe('[Provider] retrying  provider=codex attempt=2');
  });

  test('a call-site field wins over the bound one', () => {
    createLogger('x').child({ n: 1 }).info('m', { n: 2 });
    expect(out[0]).toBe('[x] m  n=2');
  });
});

describe('context resolver', () => {
  test('absent resolver logs without ids rather than throwing', () => {
    expect(() => createLogger('boot').info('before any session')).not.toThrow();
    expect(out[0]).toBe('[boot] before any session');
  });

  test('a resolver returning undefined is fine too', () => {
    setLogContextResolver(() => undefined);
    createLogger('boot').info('no turn');
    expect(out[0]).toBe('[boot] no turn');
  });
});
