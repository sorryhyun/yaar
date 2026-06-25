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

const DC_LOGIN_URL = 'https://msign.dcinside.com/login?r_url=https%3A%2F%2Fm.dcinside.com%2Fboard%2Fthesingularity';
// Use mobile gallery URL for verification — the tab is opened with mobile UA,
// so a desktop URL forces an extra redirect / longer render wait.
const DC_VERIFY_URL = 'https://m.dcinside.com/board/thesingularity';
const DC_VERIFY_URL_HTTP = 'https://gall.dcinside.com/mgallery/board/lists?id=thesingularity';

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

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

    // 5. Fill the textarea (property-descriptor setter bypasses controlled inputs).
    step = 'fill';
    await web.click({ browserId, selector: COMMENT_SELECTOR }).catch(() => {});
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

    // 7. Confirm by polling the textarea client-side (it clears on success).
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
            return memo ? memo.value.trim() === '' : true;
          })()`,
        })
        .catch(() => null)) as { data?: boolean } | null;
      if (r?.data === true) {
        cleared = true;
        break;
      }
    }

    if (!cleared) {
      return { ok: false, error: '댓글 등록 확인 실패 — 등록되지 않았을 수 있습니다. 다시 시도해주세요.' };
    }

    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Surface exactly which browser step failed (the /api/browser 500 source).
    console.error(`[postCommentToDC] step="${step}" failed:`, msg, e);
    return { ok: false, error: `댓글 작성 실패 (단계: ${step}): ${msg}` };
  }
}

