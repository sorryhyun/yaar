/**
 * auth.ts — DCinside login & comment posting via browser automation
 *
 * Login uses evaluate() to call DC's own loginRequest() function rather than
 * raw HTTP, because the form requires client-side CSRF validation and hidden
 * field population that cannot be replicated server-side.
 *
 * Comment posting similarly uses evaluate() to fill the textarea and trigger
 * DC's comment_write_ok() AJAX handler, which manages its own CSRF tokens.
 *
 * Sessions (cookie strings) are persisted to appStorage so login survives
 * app restarts. checkLoginStatus() verifies via HTTP GET against a known
 * authenticated page.
 */
import { invoke, appStorage } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';
import { openOrNavigate, isTabInitialized, syncCookiesToTab, MAIN_TAB, DC_COOKIE_URLS } from './browser';
import type { Post } from './types';

const SESSION_PATH = 'auth/session.json';

const GALLERY_ID = 'thesingularity';
/** Mobile DC new-post write page for the gallery. */
const DC_WRITE_URL = `https://m.dcinside.com/write/${GALLERY_ID}`;
/** Pattern a successful write redirects to: the created post's detail page. */
const POST_DETAIL_RE = new RegExp(`/board/${GALLERY_ID}/(\\d+)`);

const DC_LOGIN_URL = 'https://msign.dcinside.com/login?r_url=https%3A%2F%2Fm.dcinside.com%2Fboard%2Fthesingularity';
// Use mobile gallery URL for verification — the tab is opened with mobile UA,
// so a desktop URL forces an extra redirect / longer render wait.
const DC_VERIFY_URL = 'https://m.dcinside.com/board/thesingularity';
const DC_VERIFY_URL_HTTP = 'https://gall.dcinside.com/mgallery/board/lists?id=thesingularity';

// iOS Safari UA: DC's server misclassifies our Android/Chrome UA as a
// "WebP-unsupported environment" and rewrites image URLs to a static
// m_webp.png notice placeholder. An iOS Safari UA is treated as WebP-capable,
// so DC serves the real viewimage.php URLs. This is a fixed spoofed UA sent
// server-side, independent of the actual host OS.
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export interface DcSession {
  /** 소켓 포맷 쿠키 헤더 ("Name=Value; Name2=Value2") */
  dcPaPP: string;
  username: string;
  savedAt: string;
}

type CookieInfo = { name: string; value: string; [key: string]: unknown };

type HttpResult = {
  ok: boolean;
  status?: number;
  body?: string;
  headers?: Record<string, string>;
};

function parseCookieResponse(raw: unknown): CookieInfo[] {
  if (Array.isArray(raw)) return raw as CookieInfo[];
  if (raw && typeof raw === 'object') {
    const data = (raw as { data?: unknown }).data;
    if (Array.isArray(data)) return data as CookieInfo[];
  }
  return [];
}

function isLoggedInPage(html: string): boolean {
  return (
    html.includes('/user/logout') ||
    html.includes('class="nick_btn"') ||
    html.includes('data-type="logout"') ||
    html.includes('로그아웃')
  );
}

export async function saveSession(session: DcSession): Promise<void> {
  await appStorage.save(SESSION_PATH, JSON.stringify(session));
}

export async function loadSession(): Promise<DcSession | null> {
  return appStorage.readJsonOr<DcSession | null>(SESSION_PATH, null);
}

export async function clearSession(): Promise<void> {
  await appStorage.save(SESSION_PATH, 'null');
}

/**
 * Browser-automated login flow:
 * 1. Visit DC main → acquire initial session cookies (ci_c, etc.)
 * 2. Navigate to login page → fill credentials via evaluate()
 * 3. Submit form (calls DC's loginRequest()) → wait for redirect
 * 4. Verify login on gallery page → collect all DC cookies → save session
 */
export async function loginToDC(
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // The MAIN_TAB is normally already initialized by the feed's initial fetch,
    // which navigated to the very same gallery URL. Skip the redundant warm-up
    // navigation in that case (≈ 1–3s saved).
    if (!isTabInitialized(MAIN_TAB)) {
      await openOrNavigate('https://m.dcinside.com/board/thesingularity', MAIN_TAB, {
        visible:   false,
        mobile:    true,
        waitUntil: 'domcontentloaded',
      });
    }

    await web.navigate(DC_LOGIN_URL, MAIN_TAB);
    await web.waitFor({ browserId: MAIN_TAB, selector: '#code', timeout: 6000 });

    // Batch all three steps (set username, set password, submit) into one
    // evaluate() call. Round-trip overhead per evaluate is non-trivial, so
    // collapsing 3 → 1 measurably tightens the login flow.
    const uJson = JSON.stringify(username);
    const pJson = JSON.stringify(password);
    await web.evaluate({ browserId: MAIN_TAB, expression: `(function(){
      function setVal(sel, val) {
        var el = document.querySelector(sel);
        if (!el) return false;
        var s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        if (s && s.set) s.set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        return true;
      }
      setVal('#code', ${uJson});
      setVal('#password', ${pJson});
      var form = document.getElementById('loginProcess');
      if (form && typeof loginRequest === 'function') {
        var ok = loginRequest();
        if (ok !== false) form.submit();
      } else if (form) {
        form.submit();
      }
    })()` });
    await web.waitFor({ browserId: MAIN_TAB, selector: '.gall-detail-lnktb, .gall-lst, .login-group, .nick_btn, [data-type="logout"]', timeout: 6000 }).catch(() => {});

    // Verify login succeeded on a known authenticated page (mobile board, same UA)
    await web.navigate(DC_VERIFY_URL, MAIN_TAB);
    await web.waitFor({ browserId: MAIN_TAB, selector: '.gall-detail-lnktb, .gall-lst, .nick_btn, [data-type="logout"]', timeout: 5000 }).catch(() => {});

    const htmlResult = await web.html({ browserId: MAIN_TAB }) as
      { ok: boolean; data?: string };
    const pageBody = htmlResult?.data ?? '';

    if (!isLoggedInPage(pageBody)) {
      return { ok: false, error: '로그인에 실패했습니다.\n아이디 또는 비밀번호를 확인해주세요.' };
    }

    // Collect all DC cookies (DC may set different names across versions)
    const rawAllCookies = await web.getCookies({ browserId: MAIN_TAB, urls: DC_COOKIE_URLS });
    const sessionCookies: CookieInfo[] = parseCookieResponse(rawAllCookies);

    if (sessionCookies.length === 0) {
      return { ok: false, error: '세션 쿠키를 가져올 수 없습니다. 로그인을 다시 시도해주세요.' };
    }

    const cookieHeader = sessionCookies.map((c) => `${c.name}=${c.value}`).join('; ');

    await saveSession({
      dcPaPP:   cookieHeader,
      username,
      savedAt:  new Date().toISOString(),
    });

    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `브라우저 로그인 오류: ${msg}` };
  }
}

export async function logoutFromDC(): Promise<void> {
  await clearSession();
}

/** Verify session is still valid by fetching a known authenticated page */
export async function checkLoginStatus(): Promise<boolean> {
  const session = await loadSession();
  if (!session?.dcPaPP) return false;

  try {
    const res = await invoke('yaar://http', {
      url:     DC_VERIFY_URL_HTTP,
      method:  'GET',
      headers: {
        'Cookie':          session.dcPaPP,
        'User-Agent':      MOBILE_UA,
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    }) as HttpResult;

    return isLoggedInPage(res.body ?? '');
  } catch {
    return false;
  }
}

/** Cookie textarea/selector variants seen across mobile DC versions. */
const COMMENT_SELECTOR =
  '#comment_memo, #reply_memo, textarea[name="memo"], textarea.comment_memo, .cmt_write_box textarea';

/**
 * Apply the stored session cookie header (dcPaPP) into an arbitrary tab.
 *
 * Used when the MAIN_TAB has not been opened in this app session (e.g. the user
 * was auto-logged-in from a persisted HTTP session, so no browser login flow
 * ran). Each cookie is set independently so one malformed entry cannot 500 the
 * whole flow.
 */
export async function applySessionCookiesToTab(browserId: string): Promise<number> {
  const session = await loadSession();
  if (!session?.dcPaPP) return 0;

  const pairs = session.dcPaPP.split(';').map((s) => s.trim()).filter(Boolean);
  let okCount = 0;
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    try {
      await web.setCookie({ browserId, name, value, domain: '.dcinside.com', path: '/' });
      okCount++;
    } catch (e) {
      console.warn(`[applySessionCookiesToTab] setCookie failed for "${name}":`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[applySessionCookiesToTab] applied ${okCount}/${pairs.length} cookies to "${browserId}"`);
  return okCount;
}

/**
 * Post a comment into the given post's browser tab.
 *
 * Self-contained: opens/navigates the tab, applies login cookies (from MAIN_TAB
 * if it's live, otherwise from the persisted session header), reloads so cookies
 * take effect, fills the textarea, submits, and confirms by polling the textarea
 * client-side (NOT via an in-page Promise, which the browser backend may refuse
 * to serialize and answer with a 500).
 *
 * Every browser step is tagged so a 500 surfaces *which* call failed.
 */
export async function postCommentToDC(
  post: Post,
  commentText: string,
  browserId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await loadSession();
  if (!session?.dcPaPP) {
    return { ok: false, error: '로그인이 필요합니다.' };
  }

  let step = 'init';
  try {
    // 1. Ensure the tab exists and is on the post URL. (The post tab may never
    //    have been opened — e.g. the body came from the fast HTTP path — in
    //    which case calling web.* on a non-existent 'post' tab 500s.)
    step = 'open-tab';
    await openOrNavigate(post.url, browserId, { visible: false, mobile: true });

    // 2. Make the tab authenticated.
    step = 'apply-cookies';
    if (isTabInitialized(MAIN_TAB)) {
      await syncCookiesToTab(browserId);
    } else {
      await applySessionCookiesToTab(browserId);
    }

    // 3. Reload so the freshly-set cookies are sent with the page request.
    step = 'reload';
    await web.navigate(post.url, browserId);

    // 4. Bring the comment form into view and wait for the textarea.
    step = 'scroll';
    await web.scroll({ direction: 'down', browserId }).catch(() => {});
    await web.scroll({ direction: 'down', browserId }).catch(() => {});

    step = 'wait-textarea';
    const found = await web
      .waitFor({ browserId, selector: COMMENT_SELECTOR, timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!found) {
      return {
        ok: false,
        error: '댓글 입력란을 찾지 못했습니다. 로그인 상태이거나 게시물이 댓글을 허용하지 않을 수 있습니다.',
      };
    }

    // 5. Fill the textarea. Prefer REAL keystrokes (CDP Input events) over a
    //    direct .value assignment: DC's anti-bot watches for human-like input
    //    events (keydown/keypress/keyup with isTrusted), and a value-setter
    //    produces only a synthetic 'input' event. Fall back to the
    //    property-descriptor setter only if real typing fails.
    step = 'fill';
    await web.click({ browserId, selector: COMMENT_SELECTOR }).catch(() => {});
    const typedOk = await web
      .type({ browserId, selector: COMMENT_SELECTOR, text: commentText })
      .then(() => true)
      .catch(() => false);
    if (!typedOk) {
      const fillRes = (await web.evaluate({
        browserId,
        expression: `(function(){
          var el = document.querySelector('#comment_memo') ||
                   document.querySelector('#reply_memo') ||
                   document.querySelector('textarea[name="memo"]') ||
                   document.querySelector('textarea.comment_memo') ||
                   document.querySelector('.cmt_write_box textarea');
          if (!el) return false;
          var s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
          if (s && s.set) s.set.call(el, ${JSON.stringify(commentText)});
          else el.value = ${JSON.stringify(commentText)};
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          el.focus();
          return true;
        })()`,
      })) as { data?: boolean };
      if (fillRes?.data === false) {
        return { ok: false, error: '댓글 입력란에 내용을 채울 수 없습니다.' };
      }
    }

    // 5b. Suppress DC's blocking alert()/confirm() dialogs and mask
    //     navigator.webdriver (the flag DC's anti-bot reads to detect Chrome
    //     automation) right before submitting, so the comment write can
    //     complete in the headless tab without a modal stalling the page.
    step = 'instrument';
    await web
      .evaluate({
        browserId,
        expression: `(function(){
          try { Object.defineProperty(navigator, 'webdriver', { get: function(){ return false; }, configurable: true }); } catch(e){}
          if (window.__dcInstrumented) return;
          window.__dcInstrumented = true;
          window.alert = function(){};
          window.confirm = function(){ return true; };
        })()`,
      })
      .catch(() => {});

    // 6. Submit: prefer DC's own submit button / handler, fall back to Enter.
    step = 'submit';
    const submitMethod = (await web.evaluate({
      browserId,
      expression: `(function(){
        var btn = document.querySelector('button.btn_cmt_write') ||
                  document.querySelector('.cmt_write_box button[type="submit"]') ||
                  document.querySelector('#comment_write button[type="submit"]') ||
                  document.querySelector('button[onclick*="comment"]');
        if (btn) { btn.click(); return 'button'; }
        if (typeof comment_write_ok === 'function') { try { comment_write_ok(); return 'fn'; } catch(e){} }
        return 'none';
      })()`,
    }).catch(() => ({ data: 'error' }))) as { data?: string };
    if (submitMethod?.data === 'none') {
      await web
        .press({ browserId, key: 'Enter', selector: COMMENT_SELECTOR })
        .catch(() => {});
    }

    // 7. Confirm. On success the textarea clears; on rejection DC leaves the
    //    textarea untouched. Poll the textarea state until it clears.
    step = 'confirm';
    let cleared = false;
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const r = (await web
        .evaluate({
          browserId,
          expression: `(function(){
            var memo = document.getElementById('comment_memo') ||
                       document.getElementById('reply_memo') ||
                       document.querySelector('textarea[name="memo"]') ||
                       document.querySelector('textarea.comment_memo') ||
                       document.querySelector('.cmt_write_box textarea');
            return { cleared: memo ? memo.value.trim() === '' : true };
          })()`,
        })
        .catch(() => null)) as { data?: { cleared?: boolean } } | null;
      if (r?.data?.cleared) {
        cleared = true;
        break;
      }
    }

    if (!cleared) {
      return {
        ok: false,
        error: '댓글이 등록되지 않았습니다. 등록 확인에 실패했습니다.',
      };
    }

    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Surface exactly which browser step failed (the /api/browser 500 source).
    console.error(`[postCommentToDC] step="${step}" failed:`, msg, e);
    return { ok: false, error: `댓글 작성 실패 (단계: ${step}): ${msg}` };
  }
}

// ============================================================
// New-post writing (mobile DC)
// ============================================================

/** Title <input> selector variants across mobile DC write versions. */
const WRITE_TITLE_SELECTOR =
  '#subject, input[name="subject"], input#subjcet, .write_subject input, input.write_subject, input[placeholder*="제목"]';

/** Content editor selector variants (textarea OR contenteditable). */
const WRITE_CONTENT_SELECTOR =
  '#memo, textarea[name="memo"], #contents, textarea[name="contents"], .write_editor [contenteditable="true"], [contenteditable="true"].note-editable, .note-editable, #contentLayout [contenteditable="true"], [contenteditable="true"]';

function readLocationHref(browserId: string): Promise<string> {
  return web
    .evaluate({ browserId, expression: 'window.location.href' })
    .then((r) => {
      const data = (r as { data?: unknown })?.data;
      return typeof data === 'string' ? data : '';
    })
    .catch(() => '');
}

/**
 * Create a new post in the gallery via browser automation.
 *
 * Mirrors postCommentToDC's pattern: open the write tab, apply login cookies,
 * reload so they take effect, fill the title / 말머리(category) / content, then
 * submit (DC's own write button / handler). Success is confirmed when the page
 * redirects to the freshly-created post's detail URL (/board/{gallery}/{num}).
 *
 * Every browser step is tagged so a backend 500 surfaces which call failed.
 */
export async function postNewPostToDC(
  input: { title: string; content: string; category?: string },
  browserId: string,
): Promise<{ ok: boolean; error?: string; postNum?: string }> {
  const session = await loadSession();
  if (!session?.dcPaPP) {
    return { ok: false, error: '로그인이 필요합니다.' };
  }

  const title = input.title.trim();
  const content = input.content.trim();
  if (!title) return { ok: false, error: '제목이 비어 있습니다.' };
  if (!content) return { ok: false, error: '본문이 비어 있습니다.' };

  let step = 'init';
  try {
    // 1. Open / navigate the write tab.
    step = 'open-tab';
    await openOrNavigate(DC_WRITE_URL, browserId, { visible: false, mobile: true });

    // 2. Authenticate the tab (cookies from MAIN_TAB if live, else persisted).
    step = 'apply-cookies';
    if (isTabInitialized(MAIN_TAB)) {
      await syncCookiesToTab(browserId);
    } else {
      await applySessionCookiesToTab(browserId);
    }

    // 3. Reload so the freshly-set cookies are sent with the page request.
    step = 'reload';
    await web.navigate(DC_WRITE_URL, browserId);

    // 4. Wait for the title input. If absent, the user is likely not logged in
    //    (DC redirects anonymous users to login / shows the guest form).
    step = 'wait-form';
    const formFound = await web
      .waitFor({ browserId, selector: WRITE_TITLE_SELECTOR, timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!formFound) {
      const href = await readLocationHref(browserId);
      if (/login|msign|sign\.dcinside/.test(href)) {
        return { ok: false, error: '로그인이 만료되었습니다. 다시 로그인해주세요.' };
      }
      return { ok: false, error: '글쓰기 폼을 찾지 못했습니다. 로그인 상태를 확인해주세요.' };
    }

    // 5. Suppress blocking dialogs and mask navigator.webdriver before interacting
    //    (same anti-bot mitigation as the comment flow).
    step = 'instrument';
    await web
      .evaluate({
        browserId,
        expression: `(function(){
          try { Object.defineProperty(navigator, 'webdriver', { get: function(){ return false; }, configurable: true }); } catch(e){}
          if (window.__dcWriteInstrumented) return;
          window.__dcWriteInstrumented = true;
          window.alert = function(){};
          window.confirm = function(){ return true; };
        })()`,
      })
      .catch(() => {});

    // 6. Select 말머리(category) if requested. Mobile DC renders headtext either
    //    as a <select> or as a button/anchor list whose choice fills a hidden
    //    input (name="headtext"/"headnum"). Match by visible label text.
    if (input.category && input.category.trim()) {
      step = 'category';
      const catJson = JSON.stringify(input.category.trim());
      await web
        .evaluate({
          browserId,
          expression: `(function(){
            var want = ${catJson};
            var norm = function(s){ return (s||'').replace(/\\s+/g,'').trim(); };
            // (a) native <select>
            var sel = document.querySelector('select[name="headtext"], select#headtext, select.subject, select[name="headnum"]');
            if (sel) {
              for (var i=0;i<sel.options.length;i++){
                if (norm(sel.options[i].textContent) === norm(want)) {
                  sel.selectedIndex = i;
                  sel.dispatchEvent(new Event('change', {bubbles:true}));
                  return 'select';
                }
              }
            }
            // (b) button / anchor list
            var nodes = document.querySelectorAll('.subject_list a, .subject_list button, .subject-list a, .subject-list button, ul.subject li a, .write_subject_list a, [class*="headtext"] a, [class*="headtext"] button');
            for (var j=0;j<nodes.length;j++){
              if (norm(nodes[j].textContent) === norm(want)) {
                nodes[j].click();
                return 'list';
              }
            }
            return 'none';
          })()`,
        })
        .catch(() => {});
    }

    // 7. Fill the title. Prefer real keystrokes; fall back to value-setter.
    step = 'fill-title';
    await web.click({ browserId, selector: WRITE_TITLE_SELECTOR }).catch(() => {});
    const titleTyped = await web
      .type({ browserId, selector: WRITE_TITLE_SELECTOR, text: title })
      .then(() => true)
      .catch(() => false);
    if (!titleTyped) {
      await web
        .evaluate({
          browserId,
          expression: `(function(){
            var el = document.querySelector(${JSON.stringify(WRITE_TITLE_SELECTOR)});
            if (!el) return false;
            var s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (s && s.set) s.set.call(el, ${JSON.stringify(title)}); else el.value = ${JSON.stringify(title)};
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
            return true;
          })()`,
        })
        .catch(() => {});
    }

    // 8. Fill the content. Works for both <textarea> and contenteditable: click
    //    to focus, type real keystrokes, then verify/fallback via evaluate.
    step = 'fill-content';
    await web.click({ browserId, selector: WRITE_CONTENT_SELECTOR }).catch(() => {});
    const contentTyped = await web
      .type({ browserId, selector: WRITE_CONTENT_SELECTOR, text: content })
      .then(() => true)
      .catch(() => false);
    const contentOk = (await web
      .evaluate({
        browserId,
        expression: `(function(){
          var el = document.querySelector(${JSON.stringify(WRITE_CONTENT_SELECTOR)});
          if (!el) return false;
          var isCE = el.getAttribute && el.getAttribute('contenteditable') === 'true';
          var cur = isCE ? (el.innerText || el.textContent || '') : (el.value || '');
          if (cur && cur.trim().length > 0) return true;
          // Fallback fill when real typing did not land.
          if (isCE) {
            el.focus();
            el.innerHTML = '';
            el.innerText = ${JSON.stringify(content)};
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('keyup', {bubbles:true}));
          } else {
            var s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (s && s.set) s.set.call(el, ${JSON.stringify(content)}); else el.value = ${JSON.stringify(content)};
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
          }
          var after = isCE ? (el.innerText || el.textContent || '') : (el.value || '');
          return after.trim().length > 0;
        })()`,
      })
      .then((r) => (r as { data?: boolean })?.data === true)
      .catch(() => false));
    if (!contentTyped && !contentOk) {
      return { ok: false, error: '본문 입력란에 내용을 채울 수 없습니다.' };
    }

    // 9. Submit: prefer DC's own write button / handler.
    step = 'submit';
    const urlBefore = await readLocationHref(browserId);
    await web
      .evaluate({
        browserId,
        expression: `(function(){
          var btn = document.querySelector('.btn_write, button.btn_write, .write_btn, button.write_btn, #btn_write, a.btn_write, button[onclick*="write"], .submit_btn, button[type="submit"]');
          if (btn) { btn.click(); return 'button'; }
          var fns = ['write_ok','writeOk','submitWrite','goWrite','board_write','articleWrite'];
          for (var i=0;i<fns.length;i++){ if (typeof window[fns[i]] === 'function'){ try { window[fns[i]](); return 'fn:'+fns[i]; } catch(e){} } }
          var form = document.querySelector('#writeForm, form[name="writeForm"], form[name="write"], form#write');
          if (form) { form.submit(); return 'form'; }
          return 'none';
        })()`,
      })
      .catch(() => {});

    // 10. Confirm: a successful write redirects to the new post's detail page.
    step = 'confirm';
    let postNum: string | undefined;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const href = await readLocationHref(browserId);
      if (!href) continue;
      const m = href.match(POST_DETAIL_RE);
      if (m && href !== urlBefore) {
        postNum = m[1];
        break;
      }
      // Some flows land on the list page (write succeeded, no detail redirect).
      if (
        href.includes(`/board/${GALLERY_ID}`) &&
        href !== urlBefore &&
        !href.includes('/write/')
      ) {
        break;
      }
    }

    const finalHref = await readLocationHref(browserId);
    if (/\/write\//.test(finalHref) && !postNum) {
      return {
        ok: false,
        error: '게시물이 등록되지 않았습니다. 등록 확인에 실패했습니다 (제목/본문/말머리를 확인해주세요).',
      };
    }

    return { ok: true, postNum };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[postNewPostToDC] step="${step}" failed:`, msg, e);
    return { ok: false, error: `게시물 작성 실패 (단계: ${step}): ${msg}` };
  }
}

