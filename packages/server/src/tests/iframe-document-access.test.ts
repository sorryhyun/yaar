/**
 * An iframe may read the document it was told to render.
 *
 * The window's content URL is chosen by the server, but the browser fetches it
 * under the window's *iframe token* — so it passes the same access gate as any
 * other storage read. Devtools previews are served out of devtools' storage
 * (`/api/storage/apps/devtools/projects/{id}/dist/…`) while the preview window
 * runs under a `preview--{id}` principal of its own, which holds no permission
 * there: every preview 403'd on its own document and the desktop rendered
 * "Cannot embed this site". `documentUri` grants that one file, `read` only.
 */
import { describe, it, expect } from 'bun:test';
import {
  requirePermission,
  resolvePrincipal,
  storageUriFor,
  storageUriForPath,
} from '../http/access.js';
import { generateAppIframeToken } from '../http/iframe-tokens.js';
import { parseContentPath } from '../lib/yaar-uri-server.js';

const PREVIEW_PATH = '/api/storage/apps/devtools/projects/anima/dist/index.html';
const PREVIEW_URI = 'yaar://apps/devtools/storage/projects/anima/dist/index.html';

/** Mint the preview window's token the way features/window/create.ts does. */
function mintPreviewToken(documentUri?: string) {
  return generateAppIframeToken('devtools-preview-anima', 'sess-1', {
    appId: 'preview--anima',
    permissions: ['yaar://storage/'], // the previewed project's declared permissions
    documentUri,
  });
}

/** Resolve the browser's request for the document, the way http/routes/files.ts does. */
function gateFor(token: string, path = PREVIEW_PATH) {
  const req = new Request(`http://127.0.0.1:8000${path}?__yaar_token=${token}`);
  const url = new URL(req.url);
  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) throw new Error('principal was denied');
  const parsed = parseContentPath(decodeURIComponent(url.pathname));
  if (parsed?.authority !== 'storage') throw new Error('not a storage path');
  const uri = storageUriFor(principal, parsed.path);
  if (typeof uri !== 'string') throw new Error('no URI for path');
  return { principal, uri };
}

describe('iframe document access', () => {
  it('names the document URI the gate will check', () => {
    const parsed = parseContentPath(PREVIEW_PATH);
    expect(parsed?.authority).toBe('storage');
    expect(storageUriForPath(parsed!.path)).toBe(PREVIEW_URI);
  });

  it('lets a preview iframe read its own document, though it lives in another app’s storage', async () => {
    const { principal, uri } = gateFor(await mintPreviewToken(PREVIEW_URI));
    expect(uri).toBe(PREVIEW_URI);
    expect(requirePermission(principal, uri, 'read')).toBeNull();
  });

  it('denies that document without the grant — the bug this guards', async () => {
    const { principal, uri } = gateFor(await mintPreviewToken(undefined));
    expect(requirePermission(principal, uri, 'read')?.status).toBe(403);
  });

  it('grants the one file, not a foothold in the storage that hosts it', async () => {
    const { principal } = gateFor(await mintPreviewToken(PREVIEW_URI));
    const sibling = 'yaar://apps/devtools/storage/projects/anima/app.json';
    expect(requirePermission(principal, sibling, 'read')?.status).toBe(403);
    expect(requirePermission(principal, PREVIEW_URI, 'delete')?.status).toBe(403);
  });

  it('resolves a traversing path to no document at all', () => {
    expect(storageUriForPath('apps/devtools/../secrets/keys.json')).toBeNull();
  });
});
