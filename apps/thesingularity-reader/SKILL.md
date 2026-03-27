# 특이점이 온다 (thesingularity-reader)

DCinside "특이점이 온다" 마이너 갤러리 리더. 게시물 목록, 본문, 댓글을 읽고
로그인 후 댓글 작성까지 지원한다.

## Launch

```
invoke('yaar://windows/thesingularity-reader', {
  action: "create",
  appId: "thesingularity-reader",
  title: "특이점이 온다",
  renderer: "iframe",
  content: "yaar://apps/thesingularity-reader"
})
```

## Architecture decisions

### Why browser automation (yaar-web) for fetching

DCinside serves dynamic, JavaScript-rendered pages with aggressive bot
protection (Cloudflare, cookie gating). A simple HTTP fetch returns either a
CAPTCHA challenge or an incomplete page. By using `yaar-web` (headless Chrome
via CDP), we get the fully-rendered DOM including JS-injected content, and the
browser handles cookie management, redirects, and CF challenges transparently.

### Why we wait for AJAX-loaded comments instead of calling the API directly

DC's mobile page loads comments via an internal AJAX endpoint
(`/ajax/response-comment`) after the initial HTML render. While we *could*
call that endpoint directly, it requires a valid CSRF token and a matching
Referer header that change per session. Instead, we simply wait for the
comment DOM (`#comment_box li.comment`) to appear after `networkidle`, then
scrape the already-rendered HTML. This is both simpler and more resilient to
endpoint changes.

### Why JS `evaluate()` for login and comment posting

Login and comment submission interact with DC's forms, which use custom
JavaScript validation functions (`loginRequest()`, `comment_write_ok()`). These
functions set hidden fields, validate CAPTCHA tokens, and perform CSRF checks
that cannot be replicated by raw HTTP requests. Using `web.evaluate()` to call
these functions directly lets us piggyback on DC's own client-side logic. The
`Object.getOwnPropertyDescriptor` trick for setting input values bypasses
React/framework-style controlled inputs that ignore direct `.value` assignment.

### Why cookie sync between browser tabs

DC stores login state in cookies scoped to various subdomains
(`.dcinside.com`, `m.dcinside.com`, `sign.dcinside.com`, etc.). The main tab
handles login and acquires these cookies. When opening a post in a separate tab
for detail viewing, we must copy cookies from the main tab via
`syncCookiesToTab()` so that the post tab is also authenticated — enabling
comment posting from within the detail view.

## File overview

| File | Purpose |
|------|---------|
| `main.ts` | App entry — mounts Solid.js root, initializes protocol + auth |
| `store.ts` | Centralized reactive state (Solid.js `createStore`) |
| `actions.ts` | User-facing actions (refresh, select post, login, comment) |
| `fetcher.ts` | Mobile DC HTML scraping — post list, body, comments |
| `auth.ts` | Browser-automated login, session persistence, comment posting |
| `browser.ts` | Multi-tab browser management, cookie sync |
| `credentials.ts` | Credential storage via appStorage |
| `protocol.ts` | App protocol registration (query/command interface) |
| `helpers.ts` | Formatting utilities |
| `types.ts` | TypeScript type definitions |
| `ui/*.ts` | Solid.js UI components |
