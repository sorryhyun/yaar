import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceRegistry } from '../handlers/uri-registry.js';
import type { VerbResult } from '../handlers/uri-registry.js';

const text = (r: VerbResult) => (r.content[0] as { type: 'text'; text: string }).text;

// Mock resolveUri
const mockResolveUri = vi.fn();
vi.mock('../handlers/uri-resolve.js', () => ({
  resolveUri: (...args: unknown[]) => mockResolveUri(...args),
  resolveResourceUri: vi.fn(),
}));

// Mock action emitter
const mockEmitAction = vi.fn();
const mockShowUserPrompt = vi.fn();
vi.mock('../mcp/action-emitter.js', () => ({
  actionEmitter: {
    emitAction: (...args: unknown[]) => mockEmitAction(...args),
    showUserPrompt: (...args: unknown[]) => mockShowUserPrompt(...args),
  },
}));

let registerUserHandlers: (registry: ResourceRegistry) => void;

beforeEach(async () => {
  vi.clearAllMocks();
  mockResolveUri.mockImplementation((u: string) => {
    // session-scoped user URIs
    if (u.startsWith('yaar://sessions/current/notifications/')) {
      const id = u.replace('yaar://sessions/current/notifications/', '');
      return { kind: 'session', resource: 'current', subKind: 'notifications', id, sourceUri: u };
    }
    if (u === 'yaar://sessions/current/notifications') {
      return { kind: 'session', resource: 'current', subKind: 'notifications', sourceUri: u };
    }
    if (u === 'yaar://sessions/current/prompts') {
      return { kind: 'session', resource: 'current', subKind: 'prompts', sourceUri: u };
    }
    if (u === 'yaar://sessions/current/clipboard') {
      return { kind: 'session', resource: 'current', subKind: 'clipboard', sourceUri: u };
    }
    return null;
  });

  const mod = await import('../handlers/user.js');
  registerUserHandlers = mod.registerUserHandlers;
});

function createRegistry() {
  const reg = new ResourceRegistry();
  registerUserHandlers(reg);
  return reg;
}

describe('User domain handlers', () => {
  describe('notifications', () => {
    it('shows a notification via invoke', async () => {
      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://sessions/current/notifications', {
        id: 'n1',
        title: 'Alert',
        body: 'Something happened',
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Alert');
      expect(mockEmitAction).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'notification.show', id: 'n1', title: 'Alert' }),
      );
    });

    it('returns error without required fields', async () => {
      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://sessions/current/notifications', {
        body: 'no title provided',
      });
      expect(result.isError).toBe(true);
    });

    it('dismisses a notification via delete', async () => {
      const reg = createRegistry();
      const result = await reg.execute('delete', 'yaar://sessions/current/notifications/n1');
      expect(result.isError).toBeFalsy();
      expect(mockEmitAction).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'notification.dismiss', id: 'n1' }),
      );
    });
  });

  describe('prompts', () => {
    it('asks user a question', async () => {
      mockShowUserPrompt.mockResolvedValue({ selectedValues: ['option1'] });

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://sessions/current/prompts', {
        action: 'ask',
        title: 'Choose',
        message: 'Pick one',
        options: [
          { value: 'option1', label: 'Option 1' },
          { value: 'option2', label: 'Option 2' },
        ],
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('option1');
    });

    it('handles dismissed prompt', async () => {
      mockShowUserPrompt.mockResolvedValue({ dismissed: true });

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://sessions/current/prompts', {
        action: 'ask',
        title: 'Choose',
        message: 'Pick one',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('dismissed');
    });

    it('requests text from user', async () => {
      mockShowUserPrompt.mockResolvedValue({ text: 'user response' });

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://sessions/current/prompts', {
        action: 'request',
        title: 'API Key',
        message: 'Enter your API key',
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toBe('user response');
    });
  });
});
