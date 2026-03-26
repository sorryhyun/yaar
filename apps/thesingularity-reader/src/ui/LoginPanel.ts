import { createSignal, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { state, setState } from '../store';
import { saveCredentials, loadCredentials, clearCredentials } from '../credentials';
import { showToast, errMsg } from '@bundled/yaar';
import { doLogin, doLogout } from '../actions';
import { loadSession } from '../auth';

export function LoginPanel() {
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [showPw, setShowPw]     = createSignal(false);

  onMount(async () => {
    const creds = await loadCredentials();
    if (creds) {
      setState('savedCredentials', creds);
      setUsername(creds.username);
      setPassword(creds.password);
    } else {
      const session = await loadSession();
      if (session?.username) setUsername(session.username);
    }
  });

  const handleLogin = async () => {
    if (!username().trim()) {
      showToast('아이디를 입력해주세요', 'error');
      return;
    }
    if (!password()) {
      showToast('비밀번호를 입력해주세요', 'error');
      return;
    }
    // 자격증명 저장
    try {
      await saveCredentials(username().trim(), password());
      setState('savedCredentials', {
        username: username().trim(),
        password: password(),
        savedAt:  new Date().toISOString(),
      });
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
    await doLogin(username().trim(), password());
  };

  const handleLogout  = async () => doLogout();

  const handleClear = async () => {
    try {
      await clearCredentials();
      setState('savedCredentials', null);
      setUsername('');
      setPassword('');
      showToast('자격증명 삭제됨', 'success');
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  };

  const formatSavedAt = (iso: string) =>
    new Date(iso).toLocaleString('ko-KR', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });

  return html`
    <div class="login-overlay">

      <!-- 헤더 -->
      <div class="login-header">
        <span class="login-title">🔐 DCinside 로그인</span>
        <button
          class="y-btn y-btn-sm y-btn-ghost"
          onClick=${() => setState('showLogin', false)}
          title="닫기"
        >✕</button>
      </div>

      <!-- 상태 바 -->
      ${() => {
        if (state.loginLoading) return html`
          <div class="login-status-bar login-status-saved">
            <span class="y-spinner"></span>
            <span>브라우저 로그인 중…</span>
          </div>
        `;
        if (state.isLoggedIn) return html`
          <div class="login-status-bar login-status-ok">
            <span class="login-status-icon">✅</span>
            <div class="login-status-info">
              <span class="login-status-user">${() => state.savedCredentials?.username ?? username()}</span>
              <span class="login-status-label">로그인됨 — 댓글 작성 가능</span>
            </div>
            <button class="y-btn y-btn-sm y-btn-danger" onClick=${handleLogout}>퇴장</button>
          </div>
        `;
        if (state.savedCredentials) return html`
          <div class="login-status-bar login-status-saved">
            <span class="login-status-icon">💾</span>
            <div class="login-status-info">
              <span class="login-status-user">${() => state.savedCredentials!.username}</span>
              <span class="login-status-label">${() => formatSavedAt(state.savedCredentials!.savedAt)} 저장 — 로그아웃 상태</span>
            </div>
          </div>
        `;
        return html`
          <div class="login-status-bar login-status-none">
            <span class="login-status-icon">🔒</span>
            <span>저장된 자격증명 없음</span>
          </div>
        `;
      }}

      <!-- 입력 폼 -->
      <div class="login-form">
        <div class="login-field">
          <label class="login-label">DCinside 아이디</label>
          <input
            class="y-input login-input"
            type="text"
            placeholder="아이디 입력"
            value=${() => username()}
            onInput=${(e: Event) => setUsername((e.target as HTMLInputElement).value)}
            disabled=${() => state.isLoggedIn || state.loginLoading}
          />
        </div>
        <div class="login-field">
          <label class="login-label">비밀번호</label>
          <div class="login-pw-wrap">
            <input
              class="y-input login-input"
              type=${() => showPw() ? 'text' : 'password'}
              placeholder="비밀번호 입력"
              value=${() => password()}
              onInput=${(e: Event) => setPassword((e.target as HTMLInputElement).value)}
              disabled=${() => state.isLoggedIn || state.loginLoading}
            />
            <button
              class="login-pw-toggle"
              type="button"
              onClick=${() => setShowPw(v => !v)}
              title=${() => showPw() ? '숨기기' : '보기'}
            >${() => showPw() ? '🙈' : '👁️'}</button>
          </div>
        </div>

        <div class="login-actions">
          ${() => state.isLoggedIn
            ? html`
                <button
                  class="y-btn y-btn-danger"
                  onClick=${handleLogout}
                  disabled=${() => state.loginLoading}
                >🔒 로그아웃</button>
              `
            : html`
                <button
                  class="y-btn y-btn-primary"
                  onClick=${handleLogin}
                  disabled=${() => state.loginLoading}
                >
                  ${() => state.loginLoading
                    ? html`<span class="y-spinner"></span><span>로그인 중…</span>`
                    : '🔐 로그인'}
                </button>
              `}
          ${() => state.savedCredentials && !state.isLoggedIn
            ? html`<button class="y-btn y-btn-danger y-btn-sm" onClick=${handleClear}>🗑️ 삭제</button>`
            : null}
        </div>
      </div>

      <!-- 안내 -->
      <div class="login-how">
        <div class="login-how-title">ℹ️ 사용법</div>
        <ul class="login-how-list">
          <li>DCinside 아이디 / 비밀번호 입력 후 <b>🔐 로그인</b></li>
          <li>브라우저가 DC 로그인 페이지를 열고 자동으로 요청을 체운합니다</li>
          <li>로그인 성공 후 게시물 상세보기 → 댓글 입력 가능</li>
          <li>세션(DCPaPP 쿠키)은 앱에 저장되어 유지됩니다</li>
          <li>로그아웃 시 저장된 세션 삭제</li>
        </ul>
      </div>

    </div>
  `;
}
