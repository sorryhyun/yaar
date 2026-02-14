# YAAR Remote Mode — Architecture Plan

## Vision

Allow users to access their local YAAR session from any device (phone, tablet, another computer) over the internet. The backend runs on the user's machine (where Claude CLI is authenticated), the frontend is hosted on a CDN, and a secure tunnel bridges them.

```
Phone / Browser                 Vercel (CDN)                    User's Machine
───────────────                 ────────────                    ──────────────

  Browser ──── HTTPS ────→  yaar.app (static frontend)
     │
     ├─── WSS ────→  tunnel (SSH / Cloudflare / bore) ────→  localhost:8000 /ws
     │                                                         (YAAR server)
     └─── HTTPS ──→  tunnel ──────────────────────────────→  localhost:8000 /api/*
                                                               (storage, pdf, sandbox, apps, browser)
```

## Why This Architecture

1. **Backend must be local** — Claude CLI auth, MCP tools, file system access, browser sessions all require the user's machine.
2. **Frontend is just static files** — React SPA, trivially hostable on Vercel free tier.
3. **Tunnel is the only moving part** — user brings their own tunnel method. No YAAR-managed infrastructure needed.

---

## Phase 1: Auth Layer (Required Foundation)

Currently YAAR has **zero authentication** on WebSocket or REST API. This must come first before any network exposure.

### 1.1 Token Generation

```typescript
// packages/server/src/remote/token.ts

// On startup (when REMOTE=1), generate a cryptographic token
const REMOTE_TOKEN = crypto.randomBytes(32).toString('base64url');
// Print to terminal + generate QR code (text-based, for phone scanning)
```

- **Env var**: `REMOTE=1` enables remote mode
- **Token storage**: In-memory only, regenerated each server start
- **Display**: Print URL + token to terminal, optionally render QR code via `qrcode-terminal`

### 1.2 WebSocket Auth

```typescript
// packages/server/src/websocket/server.ts — on connection

const url = new URL(req.url, 'http://localhost');
const token = url.searchParams.get('token');

if (isRemoteMode() && token !== REMOTE_TOKEN) {
  ws.close(4001, 'Unauthorized');
  return;
}
```

### 1.3 REST API Auth

```typescript
// packages/server/src/http/server.ts — middleware

if (isRemoteMode()) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${REMOTE_TOKEN}`) {
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }
}
```

Exempt routes: `/health` (for tunnel health checks).

### 1.4 Origin Validation

When remote mode is active, validate the `Origin` header on WebSocket upgrade to prevent cross-site WebSocket hijacking:

```typescript
const ALLOWED_ORIGINS = [
  'https://yaar.app',        // Production frontend
  'http://localhost:5173',    // Dev frontend
];
```

---

## Phase 2: Network Binding & CORS

### 2.1 Bind to 0.0.0.0

```typescript
// packages/server/src/lifecycle.ts

const BIND_HOST = isRemoteMode() ? '0.0.0.0' : '127.0.0.1';
server.listen(PORT, BIND_HOST, () => { ... });
```

### 2.2 CORS Headers

When remote mode is active, the backend needs CORS headers since the frontend is on a different origin:

```typescript
// packages/server/src/http/server.ts

if (isRemoteMode()) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
}
```

---

## Phase 3: Frontend — Connection Dialog & Remote Mode

### 3.1 Connection Flow

When the frontend is hosted on Vercel (no local backend available), it needs to:

1. **Detect remote mode**: No backend at relative `/ws` path → show connection dialog
2. **Connection dialog UI**: Input field for backend URL + token (or paste full URL)
3. **QR code scanning**: Option to scan QR code from terminal output (camera API)
4. **Persist in localStorage**: Remember last connection for reconnect

### 3.2 URL Format

```
https://yaar.app/connect?backend=wss://abc123.example.com&token=xyz123
```

Or a single compact URL:

```
https://yaar.app/connect#wss://abc123.example.com?token=xyz123
```

Using hash fragment keeps the token out of server logs.

### 3.3 Transport Manager Changes

```typescript
// packages/frontend/src/hooks/use-agent-connection/transport-manager.ts

function getWsUrl(sessionId: string): string {
  // Priority:
  // 1. URL hash/query params (from QR code / shared link)
  // 2. localStorage saved connection
  // 3. VITE_WS_URL env var
  // 4. Default: relative /ws (local mode)

  const remote = getRemoteConnection(); // from URL or localStorage
  if (remote) {
    const url = new URL(remote.backendUrl);
    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('token', remote.token);
    return url.toString();
  }

  // ... existing logic
}
```

### 3.4 API Base URL

REST API calls (`/api/apps`, `/api/storage/*`, etc.) also need to go through the tunnel:

```typescript
// packages/frontend/src/lib/api.ts (new)

export function getApiBaseUrl(): string {
  const remote = getRemoteConnection();
  if (remote) {
    // Convert wss://host/ws → https://host
    const url = new URL(remote.backendUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    return url.toString();
  }
  return ''; // relative URLs for local mode
}
```

All fetch calls need to use this base URL and include the auth token.

---

## Phase 4: Image & Asset Handling in Remote Mode

This is the critical piece. YAAR serves many assets over HTTP from the backend:

| Route | Content | Used For |
|-------|---------|----------|
| `/api/storage/*` | User files | File viewer, downloads |
| `/api/pdf/{path}/{page}` | Rendered PDF pages | PDF viewer |
| `/api/sandbox/{id}/*` | Compiled app HTML/JS | Interactive apps |
| `/api/apps/{id}/icon` | App icons (PNG) | Desktop icons |
| `/api/apps/{id}/static/*` | App static assets | App content |
| `/api/browser/{id}/screenshot` | Browser screenshots | Browser tool |
| `/api/browser/{id}/events` | SSE stream | Live browser updates |

### 4.1 Why It Works Through a Tunnel

**Good news**: All of these are standard HTTP routes on the same port as the WebSocket. A tunnel that exposes `localhost:8000` automatically handles all of them. No special image proxying needed.

```
Phone requests /api/storage/image.png
  → tunnel forwards to localhost:8000/api/storage/image.png
  → server serves the file
  → response flows back through tunnel
```

### 4.2 Frontend Asset URL Rewriting

The challenge: frontend currently uses **relative URLs** for assets (e.g., `/api/storage/photo.png`). In remote mode, these must point to the tunnel.

**Solution**: A URL rewriter that prepends the backend base URL:

```typescript
// packages/frontend/src/lib/remote-url.ts

export function resolveBackendUrl(path: string): string {
  const base = getApiBaseUrl();
  if (!base) return path; // local mode — relative URL works

  const url = new URL(path, base);
  url.searchParams.set('token', getRemoteToken());
  return url.toString();
}
```

This must be applied in:
- **ImageComponent renderer** — `src` prop
- **IframeRenderer** — iframe `src` for sandbox/app URLs
- **App icons** — desktop icon URLs
- **PDF viewer** — page image URLs
- **Browser viewer** — screenshot URLs

### 4.3 WebSocket Image Data (Already Works)

Window captures and rendering feedback send images as **base64 strings over WebSocket**. This already works through any tunnel since it's just text data in JSON messages. No changes needed.

### 4.4 Iframe SDK Scripts (Needs Attention)

Compiled sandbox apps get injected SDK scripts that make fetch calls to:
- `/api/storage/*` (storage SDK)
- `/api/fetch` (fetch proxy)

In remote mode, these relative URLs won't resolve correctly inside an iframe served through the tunnel.

**Solution**: Inject the backend base URL into the SDK scripts:

```typescript
// When compiling sandbox HTML for remote mode
const sdkConfig = `window.__YAAR_BACKEND__ = "${getApiBaseUrl()}";`;
```

The SDK scripts then use `window.__YAAR_BACKEND__` as base URL for their requests.

### 4.5 Browser Session SSE

The browser tool uses Server-Sent Events (`/api/browser/{id}/events`) for live updates. SSE works over HTTP through tunnels, but the frontend needs to use the full tunnel URL:

```typescript
const eventSource = new EventSource(resolveBackendUrl(`/api/browser/${sessionId}/events`));
```

---

## Phase 5: Vercel Deployment

### 5.1 Vercel Config

```json
// vercel.json (project root)
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "pnpm --filter @yaar/shared build && pnpm --filter @yaar/frontend build",
  "outputDirectory": "packages/frontend/dist",
  "installCommand": "pnpm install",
  "framework": "vite",
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ],
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    }
  ]
}
```

### 5.2 Build Considerations

- `@yaar/shared` must be built before `@yaar/frontend` (types dependency)
- Server code is NOT deployed — Vercel only serves the static frontend
- Environment variable: `VITE_REMOTE_MODE=true` to build frontend in remote-aware mode

### 5.3 Vercel Free Tier Limits

| Resource | Limit | Sufficient? |
|----------|-------|-------------|
| Bandwidth | 100 GB/month | Yes — SPA is ~2MB, this serves ~50,000 page loads |
| Deployments | Unlimited | Yes |
| Custom domains | Unlimited | Yes |
| SSL/TLS | Automatic | Yes |
| Commercial use | Not allowed | Hobby tier only |

---

## Phase 6: Tunnel Options (User's Choice)

YAAR doesn't need to manage the tunnel — just document and optionally automate it.

### 6.1 Supported Tunnel Methods

| Method | Command | Setup | Best For |
|--------|---------|-------|----------|
| **Cloudflare Tunnel** | `cloudflared tunnel --url localhost:8000` | Cloudflare account | Most reliable, free |
| **SSH reverse tunnel** | `ssh -R 80:localhost:8000 serveo.net` | None | Zero setup |
| **bore** | `bore local 8000 --to bore.pub` | `cargo install bore-cli` | Simple, open source |
| **ngrok** | `ngrok http 8000` | ngrok account | Popular, has free tier |
| **Tailscale Funnel** | `tailscale funnel 8000` | Tailscale installed | If already using Tailscale |

### 6.2 Optional `yaar remote` CLI Command (Future)

```bash
$ yaar remote
# or: REMOTE=1 make dev

🔒 Remote mode enabled
📡 Starting tunnel...

  ┌──────────────────────────────────────────┐
  │                                          │
  │   Open on your phone:                    │
  │                                          │
  │   https://yaar.app/connect#...token...   │
  │                                          │
  │   ██████████████  (QR code)              │
  │   ██████████████                         │
  │   ██████████████                         │
  │                                          │
  └──────────────────────────────────────────┘

  Or manually:
    Backend URL: wss://abc123.trycloudflare.com/ws
    Token: k8Jx_mN2p...

  Press Ctrl+C to stop
```

Auto-detection order: `cloudflared` → `bore` → `ssh serveo.net` → manual instructions.

---

## Phase 7: Security Considerations

### 7.1 Threat Model

| Threat | Mitigation |
|--------|------------|
| Token brute-force | 256-bit random token (base64url), rate-limit auth failures |
| Token in URL logs | Use hash fragment (`#`) not query param for shared links |
| CSRF / WebSocket hijack | Origin validation on WebSocket upgrade |
| Man-in-the-middle | Tunnel provides TLS (Cloudflare, ngrok, etc.) |
| MCP token exposure | MCP token is separate, internal only — never sent to frontend |
| Storage path traversal | Already protected by `safePath()` — no change needed |
| Open proxy abuse | `/api/fetch` domain allowlist already exists |

### 7.2 Token Rotation

- Token regenerated on each server restart
- Future: `POST /api/remote/rotate-token` to rotate without restart
- Future: Short-lived tokens with refresh mechanism

### 7.3 Read-Only Mode (Future)

Optional flag to limit remote access to viewing only:
- Disable user input (no `USER_MESSAGE` events)
- Block write operations on storage
- Useful for sharing a live demo without giving control

---

## Implementation Order

### MVP (Phase 1-3): ~3-4 days
1. **Auth layer** — Token generation, WebSocket auth, REST auth
2. **Network binding** — `0.0.0.0` + CORS when `REMOTE=1`
3. **Frontend connection dialog** — URL + token input, localStorage persistence
4. **Frontend URL rewriting** — `resolveBackendUrl()` for all asset references

### Polish (Phase 4-5): ~2-3 days
5. **Vercel deployment** — `vercel.json`, build pipeline, env vars
6. **Iframe SDK patching** — Backend URL injection for sandbox apps
7. **QR code** — Terminal QR code output for easy phone connection

### Future (Phase 6-7)
8. **`yaar remote` CLI** — Auto-detect tunnel, generate URL, print QR
9. **Token rotation API** — Rotate without restart
10. **Read-only mode** — View-only remote access

---

## File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `packages/server/src/remote/token.ts` | Token generation and validation |
| `packages/server/src/remote/config.ts` | Remote mode configuration |
| `packages/frontend/src/lib/remote.ts` | Remote connection state (URL, token, localStorage) |
| `packages/frontend/src/components/connect/ConnectDialog.tsx` | Connection UI |
| `vercel.json` | Vercel deployment config |

### Modified Files
| File | Change |
|------|--------|
| `packages/server/src/lifecycle.ts` | Bind host based on remote mode |
| `packages/server/src/http/server.ts` | CORS + auth middleware |
| `packages/server/src/websocket/server.ts` | Token validation on connect |
| `packages/frontend/src/hooks/use-agent-connection/transport-manager.ts` | Remote URL construction |
| `packages/frontend/src/components/windows/renderers/ImageRenderer.tsx` | Use `resolveBackendUrl()` |
| `packages/frontend/src/components/windows/renderers/IframeRenderer.tsx` | Use `resolveBackendUrl()` |
| `packages/frontend/src/components/desktop/AppIcon.tsx` | Use `resolveBackendUrl()` for icons |
| `packages/server/src/mcp/dev/compile.ts` | Inject backend URL into SDK scripts |

---

## Open Questions

1. **Domain**: Host frontend at `yaar.app`? `yaar.dev`? Something else?
2. **Default tunnel provider**: Should `yaar remote` default to Cloudflare or SSH-based?
3. **Multi-user**: Should one server support multiple remote tokens (e.g., share read-only with a friend)?
4. **Mobile UX**: Should the frontend detect mobile and switch to a touch-optimized layout?
5. **Bandwidth**: For heavy image/PDF workflows, should we add compression or downscaling for remote connections?
