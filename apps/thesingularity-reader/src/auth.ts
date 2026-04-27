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
import { openOrNavigate, isTabInitialized, MAIN_TAB, DC_COOKIE_URLS } from './browser';
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

/**
 * Post a comment from the post's browser tab.
 * Caller must syncCookiesToTab() first so the tab has login cookies.
 */
export async function postCommentToDC(
  _post: Post,
  commentText: string,
  browserId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await loadSession();
  if (!session?.dcPaPP) {
    return { ok: false, error: '로그인이 필요합니다.' };
  }

  try {

    await web.scroll({ direction: 'down', browserId });
    await web.scroll({ direction: 'down', browserId });

    await web.waitFor({
      browserId,
      selector: '#comment_memo, #reply_memo, textarea[name="memo"]',
      timeout: 8000,
    });

    // Click textarea to ensure focus
    await web.click({ browserId, selector: '#comment_memo, #reply_memo, textarea[name="memo"]' });

    // Set textarea value via property descriptor (bypasses framework controls)
    await web.evaluate({ browserId, expression: `(function(){
      var el = document.querySelector('#comment_memo') ||
               document.querySelector('#reply_memo') ||
               document.querySelector('textarea[name="memo"]');
      if (!el) return false;
      var s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (s && s.set) s.set.call(el, ${JSON.stringify(commentText)});
      else el.value = ${JSON.stringify(commentText)};
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return true;
    })()` });

    // Set CSRF token if present
    await web.evaluate({ browserId, expression: `(function(){
      var csrf = document.querySelector('meta[name="csrf-token"]');
      var token = csrf ? csrf.getAttribute('content') : '';
      var tokenField = document.querySelector('#comment_write input[name="_token"]');
      if (tokenField) tokenField.value = token;
    })()` });

    // Press Enter to submit
    await web.press({ browserId, key: 'Enter', selector: '#comment_memo, #reply_memo, textarea[name="memo"]' });

    // Wait for AJAX completion — textarea clears on success
    const submitted = await web.evaluate({ browserId, expression: `new Promise(function(resolve) {
      var attempts = 0;
      var check = setInterval(function() {
        var memo = document.getElementById('comment_memo') ||
                   document.querySelector('textarea[name="memo"]');
        attempts++;
        if (memo && memo.value.trim() === '') {
          clearInterval(check);
          resolve(true);
        } else if (attempts > 200) {
          clearInterval(check);
          resolve(false);
        }
      }, 300);
    })` }) as { data?: boolean };

    if (submitted?.data === false) {
      return { ok: false, error: '댓글 등록 시간 초과 — 다시 시도해주세요.' };
    }

    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `댓글 작성 오류: ${msg}` };
  }
}

