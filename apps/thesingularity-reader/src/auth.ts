/**
 * auth.ts — DCinside 로그인 / 댓글 작성
 *
 * 로그인: 헤드리스 브라우저로 DC 로그인 페이지 자동화
 * 세션 복원: appStorage에서 세션 읽어 자동 로그인
 * 댓글: 헤드리스 브라우저 자동화 (yaar-web) — m.dcinside.com 댓글 폼 직접 제출
 */
import { invoke, appStorage } from '@bundled/yaar';
import * as web from '@bundled/yaar-web';
import { openOrNavigate, MAIN_TAB, DC_COOKIE_URLS } from './browser';
import type { Post } from './types';

const GALLERY_ID = 'thesingularity';
const SESSION_PATH = 'auth/session.json';

const DC_LOGIN_URL = 'https://msign.dcinside.com/login?r_url=https%3A%2F%2Fm.dcinside.com%2Fboard%2Fthesingularity';
const DC_VERIFY_URL = 'https://gall.dcinside.com/mini/board/lists/?id=singularity';

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

/** Extract cookie array from web.getCookies response ({ ok, data }) */
function parseCookieResponse(raw: unknown): CookieInfo[] {
  if (Array.isArray(raw)) return raw as CookieInfo[];
  if (raw && typeof raw === 'object') {
    const data = (raw as { data?: unknown }).data;
    if (Array.isArray(data)) return data as CookieInfo[];
  }
  return [];
}

/** DC 페이지 HTML에 로그인 상태 마커가 있는지 확인 */
function isLoggedInPage(html: string): boolean {
  return (
    html.includes('/user/logout') ||
    html.includes('class="nick_btn"') ||
    html.includes('data-type="logout"') ||
    html.includes('로그아웃')
  );
}

// =====================================================================
// 세션 저장 / 불러오기
// =====================================================================

export async function saveSession(session: DcSession): Promise<void> {
  await appStorage.save(SESSION_PATH, JSON.stringify(session));
}

export async function loadSession(): Promise<DcSession | null> {
  return appStorage.readJsonOr<DcSession | null>(SESSION_PATH, null);
}

export async function clearSession(): Promise<void> {
  await appStorage.save(SESSION_PATH, 'null');
}

// =====================================================================
// 브라우저 자동화 로그인
// =====================================================================

/**
 * DCinside 로그인 — 브라우저 자동화 방식
 *
 * 1) DC 메인 페이지 방문 → 초기 세션 쿠키(ci_c 등) 브라우저에 설정
 * 2) 로그인 페이지 방문 → getCookies()로 초기 쿠키 확보 확인
 * 3) #id / password 필드 자동 입력
 * 4) 폼 제출 → 리다이렉트 완료 대기
 * 5) 검증 URL에서 로그인 성공 여부 확인
 * 6) getCookies()로 DC 세션 쿠키(DCPaPP 등) 수집 → saveSession()
 */
export async function loginToDC(
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // ── Step 1: DC 메인 페이지 방문 (main 탭) → 초기 세션 쿠키 + 브라우저 초기화 ──
    await openOrNavigate('https://m.dcinside.com/board/thesingularity', MAIN_TAB, {
      visible:   true,
      mobile:    true,
      waitUntil: 'domcontentloaded',
    });

    // ── Step 2: 로그인 페이지로 이동 ─────────────────────────────────────────
    await web.navigate(DC_LOGIN_URL, MAIN_TAB);
    await web.waitFor({ browserId: MAIN_TAB, selector: '#code', timeout: 8000 });

    // 초기 쿠키 수집
    const rawInitCookies = await web.getCookies({ browserId: MAIN_TAB, urls: DC_COOKIE_URLS });
    const initCookies: CookieInfo[] = parseCookieResponse(rawInitCookies);
    console.log('[auth] 초기 세션 쿠키 확보:', initCookies.map(c => `${c.name}@${(c as CookieInfo & { domain?: string }).domain ?? '?'}`).join(', ') || '(없음)');

    // ── Step 3: 아이디 / 비밀번호 자동 입력 ─────────────────────────────────
    await web.click({ browserId: MAIN_TAB, selector: '#code' });
    await web.type({ browserId: MAIN_TAB, selector: '#code',      text: username });
    await web.type({ browserId: MAIN_TAB, selector: '#password',  text: password });

    // ── Step 4: 폼 제출 → 리다이렉트 대기 ──────────────────────────────────
    await web.click({ browserId: MAIN_TAB, selector: '#loginAction' });
    // Wait for login redirect to complete (r_url → gallery page)
    await new Promise<void>(resolve => setTimeout(resolve, 3000));

    // ── Step 5: 검증 페이지로 이동 + 로그인 상태 확인 ──────────────────────
    await web.navigate(DC_VERIFY_URL, MAIN_TAB);
    await new Promise<void>(resolve => setTimeout(resolve, 2000));

    const htmlResult = await web.html({ browserId: MAIN_TAB }) as
      { ok: boolean; data?: string };
    const pageBody = htmlResult?.data ?? '';

    if (!isLoggedInPage(pageBody)) {
      return { ok: false, error: '로그인에 실패했습니다.\n아이디 또는 비밀번호를 확인해주세요.' };
    }

    // ── Step 6: 로그인 후 DC 세션 쿠키 수집 ──────────────────────────────────
    const rawAllCookies = await web.getCookies({ browserId: MAIN_TAB, urls: DC_COOKIE_URLS });
    const allCookies: CookieInfo[] = parseCookieResponse(rawAllCookies);
    console.log('[auth] 로그인 후 전체 쿠키:', allCookies.map(c => `${c.name}@${(c as CookieInfo & { domain?: string }).domain ?? '?'}`).join(', ') || '(없음)');

    // Use all cookies from DC domains — not just the hardcoded list
    // DC may set different cookie names across versions
    const sessionCookies = allCookies.length > 0 ? allCookies : [];
    console.log('[auth] 매칭된 세션 쿠키:', sessionCookies.map(c => c.name).join(', ') || '(없음)');

    if (sessionCookies.length === 0) {
      return { ok: false, error: '세션 쿠키를 가져올 수 없습니다. 로그인을 다시 시도해주세요.' };
    }

    const cookieHeader = sessionCookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    // ── Step 7: 세션 저장 ────────────────────────────────────────────────
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

export async function checkLoginStatus(): Promise<boolean> {
  const session = await loadSession();
  if (!session?.dcPaPP) return false;

  try {
    const res = await invoke('yaar://http', {
      url:     DC_VERIFY_URL,
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

// =====================================================================
// 댓글 작성 — 게시물 탭에서 쿠키 동기화 후 실행
// =====================================================================

/**
 * 게시물 탭에서 댓글을 등록한다.
 * 호출 전에 syncCookiesToTab()으로 로그인 쿠키를 복사해야 한다.
 * browserId는 해당 게시물이 열린 탭 (postTabId).
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

    // Step 2: 페이지 맨 아래로 스크롤 (댓글 입력창 노출)
    await web.scroll({ direction: 'down', browserId });
    await web.scroll({ direction: 'down', browserId });

    // Step 3: 댓글 textarea 대기
    await web.waitFor({
      browserId,
      selector: '#comment_memo, #reply_memo, textarea[name="memo"]',
      timeout: 8000,
    });

    // Step 4: 텍스트 입력
    await web.type({
      browserId,
      selector: '#comment_memo, #reply_memo, textarea[name="memo"]',
      text: commentText,
    });

    // Step 5: 등록 버튼 클릭
    await web.click({
      browserId,
      selector: '.btn-comment-write, .btn_submit, button[type="submit"]',
    });

    // Step 6: 요청 완료 대기 후 결과 확인
    await new Promise<void>(resolve => setTimeout(resolve, 2000));

    const htmlResult = await web.html({ browserId }) as { ok?: boolean; data?: string };
    const pageBody = (htmlResult?.data ?? '').trim();

    if (pageBody.includes('로그인') && pageBody.includes('필요')) {
      return { ok: false, error: '세션이 만료되었습니다. 다시 로그인해 주세요.' };
    }
    if (pageBody.includes('차단') || pageBody.includes('blocked') || pageBody.includes('금지')) {
      return { ok: false, error: '댓글이 차단되었습니다.' };
    }

    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `댓글 작성 오류: ${msg}` };
  }
}

// =====================================================================
// 댓글 불러오기 (AJAX API)
// =====================================================================

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
        'User-Agent':       MOBILE_UA,
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
