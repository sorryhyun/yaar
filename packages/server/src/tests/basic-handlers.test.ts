import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceRegistry } from '../uri/registry.js';
import type { VerbResult } from '../uri/registry.js';
import type { ResolvedUri } from '../uri/resolve.js';

/** Extract text from first content item. */
const text = (r: VerbResult) => (r.content[0] as { type: 'text'; text: string }).text;

// Mock storage functions
const mockStorageRead = vi.fn();
const mockStorageWrite = vi.fn();
const mockStorageList = vi.fn();
const mockStorageDelete = vi.fn();
const mockResolvePath = vi.fn();

// Mock sandbox functions
const mockGetSandboxPath = vi.fn();
const mockGenerateSandboxId = vi.fn();

// Mock resolveUri — the registry calls this to turn a URI string into a ResolvedUri
const mockResolveUri = vi.fn();

vi.mock('../uri/resolve.js', () => ({
  resolveUri: (...args: unknown[]) => mockResolveUri(...args),
  resolveResourceUri: vi.fn(),
}));

vi.mock('../storage/index.js', () => ({
  storageRead: (...args: unknown[]) => mockStorageRead(...args),
  storageWrite: (...args: unknown[]) => mockStorageWrite(...args),
  storageList: (...args: unknown[]) => mockStorageList(...args),
  storageDelete: (...args: unknown[]) => mockStorageDelete(...args),
}));

vi.mock('../storage/storage-manager.js', () => ({
  resolvePath: (...args: unknown[]) => mockResolvePath(...args),
}));

vi.mock('../lib/compiler/index.js', () => ({
  getSandboxPath: (...args: unknown[]) => mockGetSandboxPath(...args),
}));

vi.mock('../mcp/domains/dev/helpers.js', () => ({
  generateSandboxId: () => mockGenerateSandboxId(),
  isValidPath: (_base: string, path: string) => !path.includes('..'),
}));

const mockStat = vi.fn();
const mockUnlink = vi.fn();
const mockMkdir = vi.fn();
const mockReaddir = vi.fn();

vi.mock('fs/promises', () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
}));

// We need to import after mocks are set up
let registerBasicHandlers: (registry: ResourceRegistry) => void;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('../mcp/verbs/handlers/basic.js');
  registerBasicHandlers = mod.registerBasicHandlers;
});

/** Helper: mock resolveUri to return a minimal resolved object for a given URI. */
function mockResolve(uri: string): void {
  mockResolveUri.mockImplementation((u: string) => {
    if (u === uri) {
      return {
        kind: 'storage',
        absolutePath: '/mock',
        readOnly: false,
        sourceUri: u,
        apiPath: '/api/mock',
      } as ResolvedUri;
    }
    return null;
  });
}

/** Like mockResolve but always returns something for any URI. */
function mockResolveAny(): void {
  mockResolveUri.mockImplementation((u: string) => {
    return {
      kind: 'storage',
      absolutePath: '/mock',
      readOnly: false,
      sourceUri: u,
      apiPath: '/api/mock',
    } as ResolvedUri;
  });
}

describe('Basic domain handlers (storage)', () => {
  function createRegistry() {
    const reg = new ResourceRegistry();
    registerBasicHandlers(reg);
    return reg;
  }

  describe('read', () => {
    it('reads a storage file', async () => {
      mockResolve('yaar://storage/notes.md');
      mockStorageRead.mockResolvedValue({
        success: true,
        content: '── notes.md (3 lines) ──\n1│hello\n2│world\n3│!',
      });

      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://storage/notes.md');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('hello');
      expect(mockStorageRead).toHaveBeenCalledWith('notes.md');
    });

    it('returns error for storage read failure', async () => {
      mockResolve('yaar://storage/missing.txt');
      mockStorageRead.mockResolvedValue({ success: false, error: 'File not found' });

      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://storage/missing.txt');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('File not found');
    });

    it('falls through to list when reading storage root (directory)', async () => {
      mockResolveAny();
      mockStorageList.mockResolvedValue({ success: true, entries: [] });
      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://storage');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('folder');
    });
  });

  describe('list', () => {
    it('lists storage directory', async () => {
      mockResolveAny();
      mockStorageList.mockResolvedValue({
        success: true,
        entries: [
          { path: 'notes.md', isDirectory: false },
          { path: 'docs', isDirectory: true },
        ],
      });

      const reg = createRegistry();
      const result = await reg.execute('list', 'yaar://storage');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('notes.md');
      expect(text(result)).toContain('docs');
    });

    it('lists storage subdirectory', async () => {
      mockResolveAny();
      mockStorageList.mockResolvedValue({
        success: true,
        entries: [{ path: 'docs/readme.md', isDirectory: false }],
      });

      const reg = createRegistry();
      const result = await reg.execute('list', 'yaar://storage/docs');
      expect(result.isError).toBeFalsy();
      expect(mockStorageList).toHaveBeenCalledWith('docs');
    });
  });

  describe('invoke (write)', () => {
    it('writes a storage file', async () => {
      mockResolveAny();
      mockStorageWrite.mockResolvedValue({ success: true });

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://storage/notes.md', {
        action: 'write',
        content: 'hello world',
      });
      expect(result.isError).toBeFalsy();
      expect(mockStorageWrite).toHaveBeenCalledWith('notes.md', 'hello world');
    });

    it('returns error when writing to storage root', async () => {
      mockResolveAny();
      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://storage', {
        action: 'write',
        content: 'hello',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('invoke (edit)', () => {
    it('edits a storage file with string mode', async () => {
      mockResolveAny();
      mockResolvePath.mockReturnValue({ absolutePath: '/tmp/storage/notes.md', readOnly: false });
      mockStorageWrite.mockResolvedValue({ success: true });
      const origBun = globalThis.Bun;
      globalThis.Bun = {
        ...origBun,
        file: vi.fn().mockReturnValue({ text: vi.fn().mockResolvedValue('hello world') }),
      } as any;

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://storage/notes.md', {
        action: 'edit',
        old_string: 'hello',
        new_string: 'goodbye',
      });

      expect(result.isError).toBeFalsy();
      expect(mockStorageWrite).toHaveBeenCalledWith('notes.md', 'goodbye world');

      globalThis.Bun = origBun;
    });

    it('edits a storage file with line mode', async () => {
      mockResolveAny();
      mockResolvePath.mockReturnValue({ absolutePath: '/tmp/storage/notes.md', readOnly: false });
      mockStorageWrite.mockResolvedValue({ success: true });
      const origBun = globalThis.Bun;
      globalThis.Bun = {
        ...origBun,
        file: vi.fn().mockReturnValue({ text: vi.fn().mockResolvedValue('line1\nline2\nline3') }),
      } as any;

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://storage/notes.md', {
        action: 'edit',
        new_string: 'replaced',
        start_line: 2,
        end_line: 2,
      });

      expect(result.isError).toBeFalsy();
      expect(mockStorageWrite).toHaveBeenCalledWith('notes.md', 'line1\nreplaced\nline3');

      globalThis.Bun = origBun;
    });

    it('returns error when old_string not found', async () => {
      mockResolveAny();
      mockResolvePath.mockReturnValue({ absolutePath: '/tmp/storage/notes.md', readOnly: false });
      const origBun = globalThis.Bun;
      globalThis.Bun = {
        ...origBun,
        file: vi.fn().mockReturnValue({ text: vi.fn().mockResolvedValue('hello world') }),
      } as any;

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://storage/notes.md', {
        action: 'edit',
        old_string: 'not found',
        new_string: 'x',
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('not found in file');

      globalThis.Bun = origBun;
    });

    it('returns error for unknown action', async () => {
      mockResolveAny();
      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://storage/notes.md', {
        action: 'rename',
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Unknown action');
    });
  });

  describe('delete', () => {
    it('deletes a storage file', async () => {
      mockResolveAny();
      mockStorageDelete.mockResolvedValue({ success: true });

      const reg = createRegistry();
      const result = await reg.execute('delete', 'yaar://storage/notes.md');
      expect(result.isError).toBeFalsy();
      expect(mockStorageDelete).toHaveBeenCalledWith('notes.md');
    });

    it('returns error when deleting storage root', async () => {
      mockResolveAny();
      const reg = createRegistry();
      const result = await reg.execute('delete', 'yaar://storage');
      expect(result.isError).toBe(true);
    });
  });

  describe('describe', () => {
    it('describes storage resource', async () => {
      const reg = createRegistry();
      const result = await reg.execute('describe', 'yaar://storage/notes.md');
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(text(result));
      expect(body.verbs).toContain('read');
      expect(body.verbs).toContain('invoke');
      expect(body.verbs).toContain('delete');
      expect(body.verbs).toContain('list');
      expect(body.invokeSchema).toBeDefined();
      expect(body.invokeSchema.properties.action).toBeDefined();
    });
  });
});

describe('Basic domain handlers (sandbox)', () => {
  function createRegistry() {
    const reg = new ResourceRegistry();
    registerBasicHandlers(reg);
    return reg;
  }

  describe('read', () => {
    it('reads a sandbox file', async () => {
      mockResolveAny();
      mockGetSandboxPath.mockReturnValue('/tmp/sandbox/12345');
      mockStat.mockResolvedValue({ isDirectory: () => false });
      const origBun = globalThis.Bun;
      globalThis.Bun = {
        ...origBun,
        file: vi.fn().mockReturnValue({ text: vi.fn().mockResolvedValue('sandbox content') }),
      } as any;

      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://sandbox/12345/index.ts');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('sandbox content');

      globalThis.Bun = origBun;
    });

    it('returns error for new sandbox read', async () => {
      mockResolveAny();
      const reg = createRegistry();
      const result = await reg.execute('read', 'yaar://sandbox/new/index.ts');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('new sandbox');
    });
  });

  describe('invoke (write to new sandbox)', () => {
    it('creates new sandbox on write', async () => {
      mockResolveAny();
      mockGenerateSandboxId.mockReturnValue('new-id');
      mockGetSandboxPath.mockReturnValue('/tmp/sandbox/new-id');
      mockMkdir.mockResolvedValue(undefined);
      const origBun = globalThis.Bun;
      globalThis.Bun = {
        ...origBun,
        write: vi.fn().mockResolvedValue(undefined),
      } as any;

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://sandbox/new/src/main.ts', {
        action: 'write',
        content: 'console.log("hi")',
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('new-id');

      globalThis.Bun = origBun;
    });

    it('writes to existing sandbox', async () => {
      mockResolveAny();
      mockGetSandboxPath.mockReturnValue('/tmp/sandbox/12345');
      mockMkdir.mockResolvedValue(undefined);
      const origBun = globalThis.Bun;
      globalThis.Bun = {
        ...origBun,
        write: vi.fn().mockResolvedValue(undefined),
      } as any;

      const reg = createRegistry();
      const result = await reg.execute('invoke', 'yaar://sandbox/12345/src/app.ts', {
        action: 'write',
        content: 'export const x = 1;',
      });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('12345');

      globalThis.Bun = origBun;
    });
  });

  describe('delete', () => {
    it('returns error for new sandbox delete', async () => {
      mockResolveAny();
      const reg = createRegistry();
      const result = await reg.execute('delete', 'yaar://sandbox/new/index.ts');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('new sandbox');
    });
  });
});
