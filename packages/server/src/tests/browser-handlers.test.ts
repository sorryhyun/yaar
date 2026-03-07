import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceRegistry } from '../uri/registry.js';
import type { VerbResult } from '../uri/registry.js';

const text = (r: VerbResult) => (r.content[0] as { type: 'text'; text: string }).text;

// Mock resolveUri
const mockResolveUri = vi.fn();
vi.mock('../uri/resolve.js', () => ({
  resolveUri: (...args: unknown[]) => mockResolveUri(...args),
  resolveResourceUri: vi.fn(),
}));

// Mock browser pool
const mockSession = {
  currentUrl: 'https://example.com',
  currentTitle: 'Example',
  windowId: 'browser-0',
  navigate: vi.fn(),
  click: vi.fn(),
  type: vi.fn(),
  press: vi.fn(),
  scroll: vi.fn(),
  navigateHistory: vi.fn(),
  hover: vi.fn(),
  waitForSelector: vi.fn(),
  screenshot: vi.fn(),
  extractContent: vi.fn(),
  findMainContentSelector: vi.fn(),
};

const mockPool = {
  isAvailable: vi.fn().mockResolvedValue(true),
  getAllSessions: vi.fn().mockReturnValue(new Map([['0', mockSession]])),
  getSession: vi.fn().mockReturnValue(mockSession),
  createSession: vi.fn(),
  closeSession: vi.fn(),
};

vi.mock('../lib/browser/index.js', () => ({
  getBrowserPool: () => mockPool,
}));

// Mock shared browser helpers
vi.mock('../mcp/browser/shared.js', async () => ({
  resolveSession: (id?: string) => {
    if (id !== undefined) {
      const s = mockPool.getSession(id);
      if (!s) throw new Error(`No browser with ID ${id}`);
      return s;
    }
    return mockSession;
  },
  formatPageState: (state: { url: string; title: string }) =>
    `URL: ${state.url}\nTitle: ${state.title}`,
  findMainContent: vi.fn().mockResolvedValue(undefined),
}));

// Mock action emitter
vi.mock('../mcp/action-emitter.js', () => ({
  actionEmitter: {
    emitAction: vi.fn(),
    emitActionWithFeedback: vi.fn().mockResolvedValue(null),
  },
}));

// Mock domains
vi.mock('../mcp/domains.js', () => ({
  isDomainAllowed: vi.fn().mockResolvedValue(true),
  extractDomain: (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  },
}));

let registerBrowserHandlers: (registry: ResourceRegistry) => Promise<void>;

beforeEach(async () => {
  vi.clearAllMocks();
  mockResolveUri.mockImplementation((u: string) => {
    if (u === 'yaar://browser' || u === 'yaar://browser/') {
      return { kind: 'browser', resource: '', sourceUri: u };
    }
    if (u.startsWith('yaar://browser/')) {
      const resource = u.replace('yaar://browser/', '');
      return { kind: 'browser', resource, sourceUri: u };
    }
    return null;
  });

  mockSession.navigate.mockResolvedValue({
    url: 'https://example.com',
    title: 'Example',
  });
  mockSession.click.mockResolvedValue({
    url: 'https://example.com',
    title: 'Example',
  });
  mockSession.scroll.mockResolvedValue({
    url: 'https://example.com',
    title: 'Example',
  });
  mockSession.screenshot.mockResolvedValue(Buffer.from('fake-image'));
  mockSession.extractContent.mockResolvedValue({
    url: 'https://example.com',
    title: 'Example',
    fullText: 'Page content here',
    links: [],
    forms: [],
  });
  mockPool.createSession.mockResolvedValue({
    session: mockSession,
    browserId: '0',
  });

  const mod = await import('../mcp/browser/handlers.js');
  registerBrowserHandlers = mod.registerBrowserHandlers;
});

async function createRegistry() {
  const reg = new ResourceRegistry();
  await registerBrowserHandlers(reg);
  return reg;
}

describe('Browser domain handlers', () => {
  describe('list', () => {
    it('lists open browsers', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('list', 'yaar://browser');
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(text(result));
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('0');
      expect(data[0].url).toBe('https://example.com');
    });

    it('returns message when no browsers open', async () => {
      mockPool.getAllSessions.mockReturnValueOnce(new Map());
      const reg = await createRegistry();
      const result = await reg.execute('list', 'yaar://browser');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('No browsers');
    });
  });

  describe('read', () => {
    it('reads browser state', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('read', 'yaar://browser/0');
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(text(result));
      expect(data.url).toBe('https://example.com');
      expect(data.title).toBe('Example');
    });
  });

  describe('invoke', () => {
    it('handles click action', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('invoke', 'yaar://browser/0', {
        action: 'click',
        selector: '#btn',
      });
      expect(result.isError).toBeFalsy();
      expect(mockSession.click).toHaveBeenCalled();
    });

    it('handles scroll action', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('invoke', 'yaar://browser/0', {
        action: 'scroll',
        direction: 'down',
      });
      expect(result.isError).toBeFalsy();
      expect(mockSession.scroll).toHaveBeenCalledWith('down');
    });

    it('handles screenshot action', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('invoke', 'yaar://browser/0', {
        action: 'screenshot',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content.length).toBe(2); // text + image
    });

    it('handles extract action', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('invoke', 'yaar://browser/0', {
        action: 'extract',
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Page content here');
    });

    it('returns error without action', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('invoke', 'yaar://browser/0', {});
      expect(result.isError).toBe(true);
    });

    it('returns error for unknown action', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('invoke', 'yaar://browser/0', {
        action: 'unknown',
      });
      expect(result.isError).toBe(true);
    });

    it('handles scroll with invalid direction', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('invoke', 'yaar://browser/0', {
        action: 'scroll',
        direction: 'left',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('delete', () => {
    it('closes browser', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('delete', 'yaar://browser/0');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('closed');
      expect(mockPool.closeSession).toHaveBeenCalledWith('0');
    });

    it('returns error for unknown browser', async () => {
      mockPool.getSession.mockReturnValueOnce(undefined);
      const reg = await createRegistry();
      const result = await reg.execute('delete', 'yaar://browser/0');
      expect(result.isError).toBe(true);
    });
  });

  describe('describe', () => {
    it('returns description for browser collection', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('describe', 'yaar://browser');
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(text(result));
      expect(data.verbs).toContain('list');
    });

    it('returns description for browser instance', async () => {
      const reg = await createRegistry();
      const result = await reg.execute('describe', 'yaar://browser/0');
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(text(result));
      expect(data.verbs).toContain('read');
      expect(data.verbs).toContain('invoke');
      expect(data.invokeSchema).toBeDefined();
    });
  });
});
