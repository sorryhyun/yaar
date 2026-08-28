/**
 * NetworkLog — the per-tab request log behind `get_network_log` (issue #96).
 * Pure: fed CDP event shapes directly, no socket.
 */
import { describe, it, expect } from 'bun:test';
import { NetworkLog, MAX_QUERY_LIMIT } from '../lib/browser/network-log.js';

const req = (id: string, url: string, extra: Record<string, unknown> = {}) => ({
  requestId: id,
  documentURL: 'https://page.test/',
  request: { url, method: 'GET' },
  type: 'XHR',
  wallTime: 1_700_000_000,
  timestamp: 10,
  ...extra,
});

describe('NetworkLog', () => {
  it('joins request, response and outcome on requestId', () => {
    const log = new NetworkLog();
    log.onRequestWillBeSent(req('1', 'https://api.test/data.json'));
    log.onResponseReceived({
      requestId: '1',
      response: { status: 200, mimeType: 'application/json', fromDiskCache: true },
    });
    log.onLoadingFinished({ requestId: '1', timestamp: 10.25, encodedDataLength: 1234 });

    const { entries, totalMatched, lastSeq } = log.query();
    expect(totalMatched).toBe(1);
    expect(lastSeq).toBe(1);
    expect(entries[0]).toMatchObject({
      seq: 1,
      requestId: '1',
      url: 'https://api.test/data.json',
      method: 'GET',
      resourceType: 'XHR',
      documentUrl: 'https://page.test/',
      startedAt: 1_700_000_000_000,
      status: 200,
      mimeType: 'application/json',
      fromCache: true,
      size: 1234,
      durationMs: 250,
    });
  });

  it('records failures and marks shield blocks', () => {
    const log = new NetworkLog();
    log.onRequestWillBeSent(req('a', 'https://ads.test/beacon'));
    log.onLoadingFailed({
      requestId: 'a',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      blockedReason: 'inspector',
    });
    log.onRequestWillBeSent(req('b', 'https://slow.test/x'));
    log.onLoadingFailed({ requestId: 'b', errorText: 'net::ERR_TIMED_OUT' });
    log.onRequestWillBeSent(req('c', 'https://ok.test/y'));
    log.onLoadingFinished({ requestId: 'c' });

    const failed = log.query({ failedOnly: true }).entries;
    expect(failed.map((e) => e.url)).toEqual(['https://ads.test/beacon', 'https://slow.test/x']);
    expect(failed[0].blocked).toBe(true);
    expect(failed[1].blocked).toBeUndefined();
    expect(failed[1].failed).toBe('net::ERR_TIMED_OUT');
  });

  it('closes a redirect hop and opens the next as its own entry', () => {
    const log = new NetworkLog();
    log.onRequestWillBeSent(req('r', 'https://short.test/abc'));
    log.onRequestWillBeSent(
      req('r', 'https://long.test/final', {
        timestamp: 10.1,
        redirectResponse: { status: 302, mimeType: 'text/html' },
      }),
    );
    log.onResponseReceived({ requestId: 'r', response: { status: 200, mimeType: 'text/html' } });
    log.onLoadingFinished({ requestId: 'r', timestamp: 10.5 });

    const { entries } = log.query();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      url: 'https://short.test/abc',
      status: 302,
      redirectedTo: 'https://long.test/final',
      durationMs: 100,
    });
    expect(entries[1]).toMatchObject({
      url: 'https://long.test/final',
      status: 200,
      durationMs: 400,
    });
  });

  it('filters by substring, wildcard, and resource type (case-insensitively)', () => {
    const log = new NetworkLog();
    log.onRequestWillBeSent(
      req('1', 'https://r1.googlevideo.com/videoplayback?itag=140', { type: 'Media' }),
    );
    log.onRequestWillBeSent(req('2', 'https://www.youtube.com/api/timedtext?v=x', { type: 'XHR' }));
    log.onRequestWillBeSent(req('3', 'https://i.ytimg.com/vi/x/hq.jpg', { type: 'Image' }));

    expect(log.query({ urlPattern: 'timedtext' }).entries.map((e) => e.seq)).toEqual([2]);
    expect(
      log.query({ urlPattern: '*googlevideo.com/videoplayback*' }).entries.map((e) => e.seq),
    ).toEqual([1]);
    expect(log.query({ resourceType: 'media' }).entries.map((e) => e.seq)).toEqual([1]);
    expect(log.query({ resourceType: ['XHR', 'Image'] }).entries.map((e) => e.seq)).toEqual([2, 3]);
    expect(log.query({ urlPattern: 'nothing' }).totalMatched).toBe(0);
  });

  it('truncates long URLs by default and returns them whole on request', () => {
    const log = new NetworkLog();
    const url = 'https://cdn.test/?sig=' + 'x'.repeat(1000);
    log.onRequestWillBeSent(req('1', url));

    const cut = log.query().entries[0];
    expect(cut.urlTruncated).toBe(true);
    expect(cut.url.length).toBe(301);

    const whole = log.query({ maxUrlLength: 0 }).entries[0];
    expect(whole.url).toBe(url);
    expect(whole.urlTruncated).toBeUndefined();
  });

  it('keeps the newest under limit, reports totalMatched, and polls with afterSeq', () => {
    const log = new NetworkLog();
    for (let i = 1; i <= 10; i++) log.onRequestWillBeSent(req(String(i), `https://t.test/${i}`));

    const r = log.query({ limit: 3 });
    expect(r.totalMatched).toBe(10);
    expect(r.entries.map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(r.lastSeq).toBe(10);

    expect(log.query({ afterSeq: 8 }).entries.map((e) => e.seq)).toEqual([9, 10]);
    expect(log.query({ limit: 10_000 }).entries).toHaveLength(10);
    expect(MAX_QUERY_LIMIT).toBeLessThan(10_000);
  });

  it('evicts oldest past capacity and stops updating an evicted row', () => {
    const log = new NetworkLog(2);
    log.onRequestWillBeSent(req('1', 'https://t.test/1'));
    log.onRequestWillBeSent(req('2', 'https://t.test/2'));
    log.onRequestWillBeSent(req('3', 'https://t.test/3'));
    // '1' fell off; a late response for it must not resurrect or crash.
    log.onResponseReceived({ requestId: '1', response: { status: 200 } });

    const r = log.query();
    expect(r.size).toBe(2);
    expect(r.capacity).toBe(2);
    expect(r.entries.map((e) => e.seq)).toEqual([2, 3]);
    expect(r.entries.every((e) => e.status === undefined)).toBe(true);
  });
});
