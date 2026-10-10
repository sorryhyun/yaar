/**
 * The domain gate asks once per burst: concurrent requests for one domain share a
 * dialog, and several unknown domains share one dialog rather than stacking a modal each.
 */
import { mock, describe, it, expect, beforeEach } from 'bun:test';

let allowedDomains = new Set<string>();

mock.module('../features/config/domains.js', () => ({
  isAllDomainsAllowed: mock(async () => false),
  isDomainAllowed: mock(async (d: string) => allowedDomains.has(d)),
  addAllowedDomain: mock(async (d: string) => {
    allowedDomains.add(d);
    return true;
  }),
  readAllowedDomains: mock(async () => [...allowedDomains]),
  setAllowAllDomains: mock(async () => true),
  extractDomain: (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  },
}));

const { actionEmitter } = await import('../session/action-emitter.js');
const { initSessionHub } = await import('../session/session-hub.js');
const { ensureDomainAllowed } = await import('../features/http/domain-gate.js');
const { savePermission, clearAllPermissions } = await import('../storage/permissions.js');

const SESSION = 'ses-domain-gate';
const hub = initSessionHub();
hub.get = ((id: string) => (id === SESSION ? {} : undefined)) as typeof hub.get;

type Request = Parameters<typeof actionEmitter.showPermissionDialogToSession>[1];
let asked: Request[] = [];
/** Each dialog waits until the test answers it. */
let answers: ((v: boolean) => void)[] = [];
actionEmitter.showPermissionDialogToSession = (async (_sid: string, req: Request) => {
  asked.push(req);
  return new Promise<boolean>((r) => answers.push(r));
}) as typeof actionEmitter.showPermissionDialogToSession;

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(pred()).toBe(true);
};
const gate = (url: string) => ensureDomainAllowed(url, { sessionId: SESSION });

describe('domain gate batching', () => {
  beforeEach(async () => {
    allowedDomains = new Set();
    asked = [];
    answers = [];
    await clearAllPermissions();
  });

  it('asks once for concurrent requests to one domain', async () => {
    const results = Promise.all([
      gate('https://market.example/a'),
      gate('https://market.example/b'),
      gate('https://market.example/c'),
    ]);
    await until(() => asked.length === 1);
    expect(asked[0]!.context).toBe('market.example');
    answers[0]!(true);
    expect(await results).toEqual([null, null, null]);
    expect(allowedDomains.has('market.example')).toBe(true);
  });

  it('puts several unknown domains in one dialog', async () => {
    const results = Promise.all([
      gate('https://market.example/a'),
      gate('https://status.example/s'),
      gate('https://market.example/b'),
    ]);
    await until(() => asked.length === 1);
    expect(asked[0]!.contexts).toEqual(['market.example', 'status.example']);
    expect(asked[0]!.message).toContain('• status.example');
    answers[0]!(true);
    expect(await results).toEqual([null, null, null]);
    expect(asked.length).toBe(1);
  });

  it('holds a late domain for the next dialog until the current one is answered', async () => {
    const first = gate('https://market.example/a');
    await until(() => asked.length === 1);
    const late = gate('https://cdn.example/x');
    const lateSame = gate('https://market.example/b');
    await new Promise((r) => setTimeout(r, 200));
    expect(asked.length).toBe(1);

    answers[0]!(false);
    expect((await first)?.reason).toBe('denied');
    expect((await lateSame)?.reason).toBe('denied');
    await until(() => asked.length === 2);
    expect(asked[1]!.context).toBe('cdn.example');
    answers[1]!(true);
    expect(await late).toBeNull();
  });

  it('answers from a saved per-domain decision without asking', async () => {
    await savePermission('http_domain', 'deny', 'blocked.example');
    await savePermission('http_domain', 'allow', 'trusted.example');
    expect((await gate('https://blocked.example/'))?.reason).toBe('denied');
    expect(await gate('https://trusted.example/')).toBeNull();
    expect(asked.length).toBe(0);
  });

  it('remembers a choice for every domain in a batched dialog', async () => {
    const { checkPermission } = await import('../storage/permissions.js');
    let dialogId = '';
    const off = (e: { event: { dialogId: string } }) => (dialogId = e.event.dialogId);
    // The real emitter, so the feedback path saves what the dialog carried.
    const stub = actionEmitter.showPermissionDialogToSession;
    delete (actionEmitter as Partial<typeof actionEmitter>).showPermissionDialogToSession;
    actionEmitter.on('approval-request', off as never);
    try {
      const results = Promise.all([gate('https://a.example/'), gate('https://b.example/')]);
      await until(() => dialogId !== '');
      await actionEmitter.resolveDialogFeedback({
        dialogId,
        confirmed: false,
        rememberChoice: 'deny_always',
      });
      expect((await results).map((r) => r?.reason)).toEqual(['denied', 'denied']);
      expect(await checkPermission('http_domain', 'a.example')).toBe('deny');
      expect(await checkPermission('http_domain', 'b.example')).toBe('deny');
    } finally {
      actionEmitter.off('approval-request', off as never);
      actionEmitter.showPermissionDialogToSession = stub;
    }
  });
});
