/**
 * auth.ts — DCinside 브라우저 자동화 로그인 / 댓글 작성
 *
 * 로그인 흐름 (브라우저 자동화 방식):
 *  1) open(DC 로그인 페이지)       → 헤드리스 브라우저 시작
 *  2) type(아이디/비밀번호 입력필드) → 자동 폼 입력
 *  3) click(로그인 버튼)              → 폼 제출 → 리다이렉트
 *  4) getCookies(같은 브라우저)      → DCPaPP 등 세션 쿠키 수집
 *  5) saveSession()                 → appStorage + 브라우저 쿠키에 저장
 *
 * 세션 복원:
 *  앱 시작 시 getCookies()로 dc_session_token 읽어 자동 로그인
 *
 * 댓글 흐름:
 *  POST https://gall.dcinside.com/board/comment/write_comment
 */
import { invoke, appStorage } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';
import type { Post } from './types';

const GALLERY_ID = 'thesingularity';
const COMMENT_WRITE_URL = 'https://gall.dcinside.com/board/comment/write_comment';
const SESSION_PATH = 'auth/session.json';

/** 로그인에 사용할 헤드리스 브라우저 ID */
const DC_LOGIN_BROWSER = 'dc-login';

/** DC 로그인 URL */
const DC_LOGIN_URL = 'https://sign.dcinside.com/login';
const DC_VERIFY_URL = 'https://m.dcinside.com/';

/** 세션 쿠키 이름 상수 (스토리지 키) */
const COOKIE_TOKEN   = 'dc_session_token';
const COOKIE_USER    = 'dc_username';
const COOKIE_SAVED_AT = 'dc_saved_at';

/** DC에서 수개해야 할 세션 쿠키 목록 */
const DC_COOKIE_NAMES = ['DCPaPP', 'PHPSESSID', 'DCcookiek', 'ci_c'];

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

// =====================================================================
// 세션 저장 / 불러오기
// =====================================================================

/**
 * 세션을 appStorage + 브라우저 쿠키 두 곳에 저장
 */
export async function saveSession(session: DcSession): Promise<void> {
  await appStorage.save(SESSION_PATH, JSON.stringify(session));
  try {
    await web.setCookie({ name: COOKIE_TOKEN,    value: session.dcPaPP,   secure: true, sameSite: 'Lax' });
    await web.setCookie({ name: COOKIE_USER,     value: session.username, secure: true, sameSite: 'Lax' });
    await web.setCookie({ name: COOKIE_SAVED_AT, value: session.savedAt,  secure: true, sameSite: 'Lax' });
  } catch (e) {
    console.warn('[auth] setCookie 실패:', e);
  }
}

/**
 * 세션 불러오기
 * 우선순위: 브라우저 쿠키 → appStorage
 */
export async function loadSession(): Promise<DcSession | null> {
  try {
    const cookies = (await web.getCookies()) as CookieInfo[];
    const tokenCookie   = cookies.find(c => c.name === COOKIE_TOKEN);
    const userCookie    = cookies.find(c => c.name === COOKIE_USER);
    const savedAtCookie = cookies.find(c => c.name === COOKIE_SAVED_AT);

    if (tokenCookie?.value) {
      const s: DcSession = {
        dcPaPP:   tokenCookie.value,
        username: userCookie?.value    ?? '',
        savedAt:  savedAtCookie?.value ?? new Date().toISOString(),
      };
      await appStorage.save(SESSION_PATH, JSON.stringify(s));
      return s;
    }
  } catch (e) {
    console.warn('[auth] getCookies 실패, appStorage fallback:', e);
  }
  return appStorage.readJsonOr<DcSession | null>(SESSION_PATH, null);
}

/**
 * 세션 삭제 (appStorage + 브라우저 쿠키 모두)
 */
export async function clearSession(): Promise<void> {
  await appStorage.save(SESSION_PATH, 'null');
  try {
    await web.deleteCookies({ name: COOKIE_TOKEN });
    await web.deleteCookies({ name: COOKIE_USER });
    await web.deleteCookies({ name: COOKIE_SAVED_AT });
  } catch (e) {
    console.warn('[auth] deleteCookies 실패:', e);
  }
}

// =====================================================================
// 브라우저 자동화 로그인
// =====================================================================

/**
 * DCinside 로그인 — 브라우저 자동화 방식
 *
 * 1) 헤드리스 브라우저에 DC 로그인 페이지 열기
 * 2) #user_id / #pw 필드에 자동 입력
 * 3) .btn_login 주클 → 폼 제출 → 리다이렉트
 * 4) m.dcinside.com 이동 후 로그인 확인 + 쿠키 수각
 * 5) DCPaPP 등 세션 쿠키를 appStorage + setCookie()에 저장
 */
export async function loginToDC(
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // ── Step 1: DC 로그인 페이지 열기 ───────────────────────────────────────
    await web.open(DC_LOGIN_URL, {
      browserId:  DC_LOGIN_BROWSER,
      visible:    false,
      waitUntil:  'networkidle',
    });

    // ── Step 2: 아이디 / 비밀번호 자동 입력 ───────────────────────────────
    await web.type({ browserId: DC_LOGIN_BROWSER, selector: '#user_id', text: username });
    await web.type({ browserId: DC_LOGIN_BROWSER, selector: '#pw',      text: password });

    // ── Step 3: 로그인 버튼 클릭 → 폼 제출 + 리다이렉트 ────────────────
    await web.click({ browserId: DC_LOGIN_BROWSER, selector: '.btn_login' });

    // ── Step 4: 리다이렉트 완료 대기 ───────────────────────────────────────
    // m.dcinside.com 이동으로 로그인 상태 + 쿠키를 한번에 확인
    await web.open(DC_VERIFY_URL, {
      browserId:  DC_LOGIN_BROWSER,
      visible:    false,
      mobile:     true,
      waitUntil:  'networkidle',
    });

    // ── Step 5: HTML로 로그인 성공 여부 확인 ───────────────────────────
    const htmlResult = await web.html({ browserId: DC_LOGIN_BROWSER }) as
      { ok: boolean; data?: string };
    const pageBody = htmlResult?.data ?? '';

    const loggedIn = (
      pageBody.includes('/user/logout')       ||
      pageBody.includes('class="nick_btn"')   ||
      pageBody.includes('data-type="logout"') ||
      pageBody.includes('로그아웃')
    );

    if (!loggedIn) {
      return { ok: false, error: '로그인에 실패했습니다.\n아이디 또는 비밀번호를 확인해주세요.' };
    }

    // ── Step 6: 브라우저 세션에서 DC 쿠키 수각 ─────────────────────────
    const allCookies = (await web.getCookies({ browserId: DC_LOGIN_BROWSER })) as CookieInfo[];

    // DC API 요청에 필요한 세션 쿠키만 필터
    const sessionCookies = allCookies.filter(c => DC_COOKIE_NAMES.includes(c.name));

    if (sessionCookies.length === 0) {
      return { ok: false, error: '세션 쿠키를 가져올 수 없습니다. 로그인을 다시 시도해주세요.' };
    }

    const cookieHeader = sessionCookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    // ── Step 7: 세션 저장 (appStorage + 앱 쿠키) ──────────────────────────
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

// =====================================================================
// 로그아웃
// =====================================================================

export async function logoutFromDC(): Promise<void> {
  await clearSession();
}

// =====================================================================
// 로그인 상태 확인
// =====================================================================

/**
 * 저장된 세션으로 로그인 상태 확인
 * m.dcinside.com에 요청하여 로그아웃 에레먼트 여부 확인
 */
export async function checkLoginStatus(): Promise<boolean> {
  const session = await loadSession();
  if (!session?.dcPaPP) return false;

  try {
    const res = await invoke('yaar://http', {
      url:     DC_VERIFY_URL,
      method:  'GET',
      headers: {
        Cookie:          session.dcPaPP,
        'User-Agent':    'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept':        'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    }) as HttpResult;

    const body = res.body ?? '';
    return (
      body.includes('/user/logout')       ||
      body.includes('class="nick_btn"')   ||
      body.includes('data-type="logout"')
    );
  } catch {
    return false;
  }
}

// =====================================================================
// 댓글 작성
// =====================================================================

/**
 * DCinside 댓글 작성
 * 로그인 세션의 쿠키를 Cookie 헤더에 포함하여 POST
 */
export async function postCommentToDC(
  post: Post,
  commentText: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await loadSession();
  if (!session?.dcPaPP) {
    return { ok: false, error: '로그인이 필요합니다.' };
  }

  try {
    const referer = `https://m.dcinside.com/board/${GALLERY_ID}/${post.num}`;
    const body = new URLSearchParams({
      id:   GALLERY_ID,
      no:   post.num,
      memo: commentText,
    }).toString();

    const res = await invoke('yaar://http', {
      url:    COMMENT_WRITE_URL,
      method: 'POST',
      headers: {
        'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer':          referer,
        'Origin':           'https://m.dcinside.com',
        'Cookie':           session.dcPaPP,
        'User-Agent':       'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept':           'application/json, text/javascript, */*; q=0.01',
        'Accept-Language':  'ko-KR,ko;q=0.9',
      },
      body,
    }) as HttpResult;

    const rawBody = (res.body ?? '').trim();
    try {
      const json = JSON.parse(rawBody);
      const result = json?.result;
      if (result === 'success' || result === 1 || result === '1' || result === true) {
        return { ok: true };
      }
      const msg = json?.msg ?? json?.message ?? '댓글 작성에 실패했습니다.';
      return { ok: false, error: String(msg) };
    } catch {
      if (res.status && res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, error: `서버 오류 (HTTP ${res.status ?? '?'}): ${rawBody.slice(0, 100)}` };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `댓글 작성 오류: ${msg}` };
  }
}

// =====================================================================
// 댓글 불러오기 (AJAX API)
// =====================================================================

/**
 * DCinside AJAX 댓글 API
 */
export async function fetchCommentsViaApi(
  postNum: string,
): Promise<{ html: string; ok: boolean }> {
  try {
    const body = new URLSearchParams({
      id:           GALLERY_ID,
      no:           postNum,
      cpage:        '1',
      managerskill: '',
      del_scope:    '1',
      csort:        '',
    }).toString();

    const res = await invoke('yaar://http', {
      url:    'https://m.dcinside.com/ajax/response-comment',
      method: 'POST',
      headers: {
        'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer':          `https://m.dcinside.com/board/${GALLERY_ID}/${postNum}`,
        'User-Agent':       'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept':           'application/json, text/javascript, */*; q=0.01',
        'Accept-Language':  'ko-KR,ko;q=0.9',
      },
      body,
    }) as HttpResult;

    return { html: res.body ?? '', ok: (res.status ?? 200) < 400 };
  } catch {
    return { html: '', ok: false };
  }
}
