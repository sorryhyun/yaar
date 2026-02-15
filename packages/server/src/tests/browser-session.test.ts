/**
 * Tests for BrowserSession — CDP-based browser tab automation.
 *
 * Mocks CDPClient to test session logic in isolation: creation with domain
 * initialization, navigation, clicking, typing, and screenshot capture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock CDP ────────────────────────────────────────────────────────────────

const FAKE_IMAGE_BASE64 = Buffer.from('fake-image').toString('base64');

/**
 * vi.hoisted() ensures these variables exist before the vi.mock factory runs,
 * since vi.mock is hoisted to the top of the file by vitest.
 */
const { mockSend, mockWaitForEvent, mockClose } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockWaitForEvent: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('../lib/browser/cdp.js', () => ({
  CDPClient: {
    connect: vi.fn().mockResolvedValue({
      send: mockSend,
      waitForEvent: mockWaitForEvent,
      close: mockClose,
    }),
  },
}));

// Import after mocks are established
import { BrowserSession } from '../lib/browser/session.js';
import { CDPClient } from '../lib/browser/cdp.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Default CDP send handler — returns sensible responses per method. */
function defaultSendHandler(method: string) {
  switch (method) {
    case 'Page.enable':
    case 'Runtime.enable':
    case 'Emulation.setDeviceMetricsOverride':
    case 'Emulation.setUserAgentOverride':
    case 'Page.navigate':
    case 'Input.dispatchMouseEvent':
    case 'Input.insertText':
      return Promise.resolve({});
    case 'Page.captureScreenshot':
      return Promise.resolve({ data: FAKE_IMAGE_BASE64 });
    case 'Runtime.evaluate':
      return Promise.resolve({
        result: { value: { url: 'https://example.com', title: 'Test Page' } },
      });
    default:
      return Promise.resolve({});
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('BrowserSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation(defaultSendHandler);
    mockWaitForEvent.mockResolvedValue(undefined);
    mockClose.mockReturnValue(undefined);
  });

  it('create initializes CDP domains and viewport', async () => {
    const session = await BrowserSession.create('sess-1', 'ws://127.0.0.1:9222/devtools/page/abc');

    // CDPClient.connect was called with the debugger URL
    expect(CDPClient.connect).toHaveBeenCalledWith('ws://127.0.0.1:9222/devtools/page/abc');

    // Required CDP domains were enabled
    expect(mockSend).toHaveBeenCalledWith('Page.enable');
    expect(mockSend).toHaveBeenCalledWith('Runtime.enable');

    // Viewport was configured
    expect(mockSend).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // User agent was set
    expect(mockSend).toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      expect.objectContaining({
        userAgent: expect.stringContaining('Chrome'),
      }),
    );

    expect(session.id).toBe('sess-1');
    expect(session.currentUrl).toBe('about:blank');
  });

  it('navigate sends Page.navigate, waits for load, takes screenshot, returns state', async () => {
    const session = await BrowserSession.create('nav-1', 'ws://localhost:9222/devtools/page/x');
    vi.clearAllMocks();

    // Track Runtime.evaluate call sequence to return appropriate values
    let evalCallCount = 0;
    mockSend.mockImplementation((method: string) => {
      if (method === 'Page.navigate') return Promise.resolve({});
      if (method === 'Page.captureScreenshot') return Promise.resolve({ data: FAKE_IMAGE_BASE64 });
      if (method === 'Runtime.evaluate') {
        evalCallCount++;
        if (evalCallCount === 1) {
          // getPageState: url + title
          return Promise.resolve({
            result: {
              value: { url: 'https://example.com/page', title: 'Navigated' },
            },
          });
        }
        // getPageState: text snippet
        return Promise.resolve({ result: { value: 'Some body text' } });
      }
      return Promise.resolve({});
    });
    mockWaitForEvent.mockResolvedValue(undefined);

    const state = await session.navigate('https://example.com/page');

    // Page.navigate was called with the target URL
    expect(mockSend).toHaveBeenCalledWith('Page.navigate', {
      url: 'https://example.com/page',
    });

    // Waited for load event with 30s timeout
    expect(mockWaitForEvent).toHaveBeenCalledWith('Page.loadEventFired', 30_000);

    // Screenshot was captured
    expect(mockSend).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 80,
    });

    // Returns page state with updated URL and title
    expect(state).toEqual(
      expect.objectContaining({
        url: 'https://example.com/page',
        title: 'Navigated',
      }),
    );

    // Session fields updated to match navigated page
    expect(session.currentUrl).toBe('https://example.com/page');
    expect(session.currentTitle).toBe('Navigated');
    expect(session.lastScreenshot).toBeInstanceOf(Buffer);
  });

  it('click with selector evaluates JS for coordinates, dispatches mouse events', async () => {
    const session = await BrowserSession.create('click-1', 'ws://localhost:9222/devtools/page/y');
    vi.clearAllMocks();

    let evalCallCount = 0;
    mockSend.mockImplementation((method: string) => {
      if (method === 'Runtime.evaluate') {
        evalCallCount++;
        if (evalCallCount === 1) {
          // Finding element coordinates via querySelector
          return Promise.resolve({ result: { value: { x: 150, y: 200 } } });
        }
        if (evalCallCount === 2) {
          // getPageState: url + title
          return Promise.resolve({
            result: {
              value: { url: 'https://example.com', title: 'Clicked' },
            },
          });
        }
        // getPageState: text snippet
        return Promise.resolve({ result: { value: '' } });
      }
      if (method === 'Page.captureScreenshot') return Promise.resolve({ data: FAKE_IMAGE_BASE64 });
      if (method === 'Input.dispatchMouseEvent') return Promise.resolve({});
      return Promise.resolve({});
    });

    const state = await session.click('#my-button');

    // Evaluated JS to find element coordinates using the provided selector
    const evalCalls = mockSend.mock.calls.filter(([m]: [string]) => m === 'Runtime.evaluate');
    expect(evalCalls.length).toBeGreaterThanOrEqual(1);
    expect(evalCalls[0][1].expression).toContain('#my-button');

    // Mouse press and release dispatched at element center coordinates
    expect(mockSend).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 150,
      y: 200,
      button: 'left',
      clickCount: 1,
    });
    expect(mockSend).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 150,
      y: 200,
      button: 'left',
      clickCount: 1,
    });

    // Returns updated page state
    expect(state.url).toBe('https://example.com');
    expect(state.title).toBe('Clicked');
  });

  it('type focuses input, inserts text, fires events', async () => {
    const session = await BrowserSession.create('type-1', 'ws://localhost:9222/devtools/page/z');
    vi.clearAllMocks();

    let evalCallCount = 0;
    mockSend.mockImplementation((method: string) => {
      if (method === 'Runtime.evaluate') {
        evalCallCount++;
        if (evalCallCount <= 2) {
          // First: focus+clear input; second: fire change events
          return Promise.resolve({ result: {} });
        }
        if (evalCallCount === 3) {
          // getPageState: url + title
          return Promise.resolve({
            result: {
              value: { url: 'https://example.com', title: 'Typed' },
            },
          });
        }
        // getPageState: text snippet
        return Promise.resolve({ result: { value: '' } });
      }
      if (method === 'Page.captureScreenshot') return Promise.resolve({ data: FAKE_IMAGE_BASE64 });
      if (method === 'Input.insertText') return Promise.resolve({});
      return Promise.resolve({});
    });

    const state = await session.type('#search-input', 'hello world');

    const evalCalls = mockSend.mock.calls.filter(([m]: [string]) => m === 'Runtime.evaluate');

    // First evaluate: focuses and clears the input element
    expect(evalCalls[0][1].expression).toContain('#search-input');
    expect(evalCalls[0][1].expression).toContain('focus');

    // Text was inserted via CDP Input.insertText
    expect(mockSend).toHaveBeenCalledWith('Input.insertText', {
      text: 'hello world',
    });

    // Second evaluate: fires input and change events
    expect(evalCalls[1][1].expression).toContain('input');
    expect(evalCalls[1][1].expression).toContain('change');

    // Returns updated page state
    expect(state.url).toBe('https://example.com');
    expect(state.title).toBe('Typed');
  });

  it('screenshot returns buffer from CDP captureScreenshot', async () => {
    const session = await BrowserSession.create('ss-1', 'ws://localhost:9222/devtools/page/ss');
    vi.clearAllMocks();

    mockSend.mockImplementation((method: string) => {
      if (method === 'Page.captureScreenshot') return Promise.resolve({ data: FAKE_IMAGE_BASE64 });
      return Promise.resolve({});
    });

    const buffer = await session.screenshot();

    // captureScreenshot called with JPEG format and quality
    expect(mockSend).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 80,
    });

    // Returns a Buffer decoded from the base64 CDP response
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.toString()).toBe('fake-image');

    // Session stores the screenshot for later retrieval
    expect(session.lastScreenshot).toBe(buffer);
  });
});
