type Repo = {
  id: number;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  updated_at: string;
  stargazers_count: number;
  forks_count: number;
};

type Issue = {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
  user?: { login: string };
  pull_request?: object;
  created_at: string;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

type DeviceTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

const root = document.createElement('div');
root.innerHTML = `
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0b1020; color: #e5e7eb; }
    .app { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
    .top { padding: 12px; border-bottom: 1px solid #1f2937; background: #0f172a; display: grid; gap: 8px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input, textarea, button { border-radius: 8px; border: 1px solid #334155; background: #111827; color: #e5e7eb; }
    input, textarea { padding: 8px 10px; }
    button { padding: 8px 12px; cursor: pointer; }
    button:hover { border-color: #60a5fa; }
    .main { display: grid; grid-template-columns: 360px 1fr; min-height: 0; }
    .panel { border-right: 1px solid #1f2937; overflow: auto; }
    .panel:last-child { border-right: 0; }
    .repos { padding: 8px; display: grid; gap: 8px; }
    .repo { border: 1px solid #334155; border-radius: 10px; padding: 10px; background: #0f172a; cursor: pointer; }
    .repo.active { border-color: #60a5fa; background: #111827; }
    .repo-title { font-weight: 600; }
    .muted { color: #94a3b8; font-size: 12px; }
    .right { padding: 12px; overflow: auto; display: grid; gap: 12px; align-content: start; }
    .card { border: 1px solid #334155; border-radius: 10px; padding: 12px; background: #0f172a; }
    .issues { display: grid; gap: 8px; }
    .issue { border: 1px solid #334155; border-radius: 8px; padding: 8px; }
    .status { font-size: 12px; color: #93c5fd; }
    .pill { display: inline-block; border: 1px solid #334155; border-radius: 999px; padding: 2px 8px; font-size: 11px; margin-left: 6px; }
    a { color: #93c5fd; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .grow { flex: 1; }
    .code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: #020617; border: 1px dashed #334155; padding: 4px 8px; border-radius: 8px; }
  </style>
  <div class="app">
    <div class="top">
      <div class="row">
        <input id="token" class="grow" type="password" placeholder="GitHub token (OAuth or PAT)" />
        <button id="saveToken">Save token</button>
        <button id="loadRepos">Load repos</button>
      </div>
      <div class="row">
        <input id="oauthClientId" class="grow" type="text" placeholder="GitHub OAuth App Client ID (for Login with GitHub)" />
        <button id="oauthLogin">Login with GitHub</button>
        <button id="oauthCancel" style="display:none;">Cancel login</button>
      </div>
      <div class="row" id="oauthHintRow" style="display:none;">
        <span class="muted">User code:</span>
        <span id="oauthUserCode" class="code">-</span>
        <button id="openVerify">Open verification page</button>
      </div>
      <div class="row">
        <input id="filter" class="grow" type="text" placeholder="Filter repos..." />
        <span id="me" class="muted"></span>
        <span id="status" class="status">Ready</span>
      </div>
    </div>
    <div class="main">
      <div class="panel">
        <div id="repos" class="repos"></div>
      </div>
      <div class="panel right">
        <div class="card">
          <div><strong id="selectedRepo">No repo selected</strong></div>
          <div class="muted" id="selectedRepoMeta"></div>
        </div>

        <div class="card">
          <div style="font-weight:600; margin-bottom:8px;">Create issue</div>
          <div class="row" style="display:grid; gap:8px;">
            <input id="issueTitle" type="text" placeholder="Issue title" />
            <textarea id="issueBody" rows="4" placeholder="Issue body"></textarea>
            <button id="createIssue">Create issue in selected repo</button>
          </div>
        </div>

        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center; gap:8px;">
            <strong>Open issues / PRs</strong>
            <button id="refreshIssues">Refresh</button>
          </div>
          <div id="issues" class="issues" style="margin-top:8px;"></div>
        </div>
      </div>
    </div>
  </div>
`;

document.body.appendChild(root);

const tokenEl = document.getElementById('token') as HTMLInputElement;
const oauthClientIdEl = document.getElementById('oauthClientId') as HTMLInputElement;
const oauthUserCodeEl = document.getElementById('oauthUserCode') as HTMLSpanElement;
const oauthHintRowEl = document.getElementById('oauthHintRow') as HTMLDivElement;
const openVerifyEl = document.getElementById('openVerify') as HTMLButtonElement;
const oauthCancelEl = document.getElementById('oauthCancel') as HTMLButtonElement;
const filterEl = document.getElementById('filter') as HTMLInputElement;
const meEl = document.getElementById('me') as HTMLSpanElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const reposEl = document.getElementById('repos') as HTMLDivElement;
const issuesEl = document.getElementById('issues') as HTMLDivElement;
const selectedRepoEl = document.getElementById('selectedRepo') as HTMLDivElement;
const selectedRepoMetaEl = document.getElementById('selectedRepoMeta') as HTMLDivElement;
const issueTitleEl = document.getElementById('issueTitle') as HTMLInputElement;
const issueBodyEl = document.getElementById('issueBody') as HTMLTextAreaElement;

let repos: Repo[] = [];
let filteredRepos: Repo[] = [];
let issues: Issue[] = [];
let selectedRepo: Repo | null = null;
let viewerLogin = '';

let oauthPendingDeviceCode = '';
let oauthVerifyUrl = '';
let oauthPollingAbort = false;

const STORAGE_PATH = 'github-manager/config.json';

function setStatus(text: string) {
  statusEl.textContent = text;
}

async function saveConfig(cfg: { token: string; oauthClientId?: string }) {
  await (window as any).yaar?.storage?.save(STORAGE_PATH, JSON.stringify(cfg));
}

async function loadConfig(): Promise<{ token?: string; oauthClientId?: string }> {
  try {
    const data = await (window as any).yaar?.storage?.read(STORAGE_PATH, { as: 'json' });
    return (data ?? {}) as { token?: string; oauthClientId?: string };
  } catch {
    return {};
  }
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function gh<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...ghHeaders(token),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function renderRepos() {
  const query = filterEl.value.trim().toLowerCase();
  filteredRepos = query
    ? repos.filter((r) => r.full_name.toLowerCase().includes(query))
    : repos;

  reposEl.innerHTML = '';

  if (!filteredRepos.length) {
    reposEl.innerHTML = `<div class="muted">No repos found.</div>`;
    return;
  }

  for (const repo of filteredRepos) {
    const div = document.createElement('div');
    div.className = `repo ${selectedRepo?.id === repo.id ? 'active' : ''}`;
    div.innerHTML = `
      <div class="repo-title">${repo.full_name}</div>
      <div class="muted">${repo.description ?? ''}</div>
      <div class="muted">★ ${repo.stargazers_count} · Forks ${repo.forks_count} · ${repo.private ? 'Private' : 'Public'}</div>
    `;
    div.onclick = async () => {
      selectedRepo = repo;
      renderRepos();
      renderSelectedRepo();
      await loadIssues();
      (window as any).yaar?.app?.sendInteraction?.({ event: 'repo_selected', repo: repo.full_name });
    };
    reposEl.appendChild(div);
  }
}

function renderSelectedRepo() {
  if (!selectedRepo) {
    selectedRepoEl.textContent = 'No repo selected';
    selectedRepoMetaEl.textContent = '';
    return;
  }
  selectedRepoEl.textContent = selectedRepo.full_name;
  selectedRepoMetaEl.innerHTML = `<a href="${selectedRepo.html_url}" target="_blank">Open on GitHub</a> · Updated ${new Date(selectedRepo.updated_at).toLocaleString()}`;
}

function renderIssues() {
  issuesEl.innerHTML = '';
  if (!selectedRepo) {
    issuesEl.innerHTML = '<div class="muted">Select a repo first.</div>';
    return;
  }
  if (!issues.length) {
    issuesEl.innerHTML = '<div class="muted">No open issues/PRs.</div>';
    return;
  }

  for (const it of issues) {
    const isPr = !!it.pull_request;
    const div = document.createElement('div');
    div.className = 'issue';
    div.innerHTML = `
      <div><a href="${it.html_url}" target="_blank">#${it.number} ${it.title}</a>${isPr ? '<span class="pill">PR</span>' : '<span class="pill">Issue</span>'}</div>
      <div class="muted">by ${it.user?.login ?? 'unknown'} · ${new Date(it.created_at).toLocaleString()}</div>
    `;
    issuesEl.appendChild(div);
  }
}

async function loadViewer() {
  const token = tokenEl.value.trim();
  if (!token) return;
  const me = await gh<{ login: string }>('/user', token);
  viewerLogin = me.login;
  meEl.textContent = `Signed in: ${viewerLogin}`;
}

async function loadRepos() {
  const token = tokenEl.value.trim();
  if (!token) {
    setStatus('Add token first');
    return;
  }
  setStatus('Loading repos...');
  try {
    await loadViewer();
    repos = await gh<Repo[]>('/user/repos?per_page=100&sort=updated', token);
    renderRepos();
    setStatus(`Loaded ${repos.length} repos`);
  } catch (e: any) {
    setStatus(e?.message || 'Failed loading repos');
  }
}

async function loadIssues() {
  const token = tokenEl.value.trim();
  if (!token || !selectedRepo) {
    renderIssues();
    return;
  }
  setStatus(`Loading issues for ${selectedRepo.full_name}...`);
  try {
    issues = await gh<Issue[]>(`/repos/${selectedRepo.full_name}/issues?state=open&per_page=30`, token);
    renderIssues();
    setStatus(`Loaded ${issues.length} items`);
  } catch (e: any) {
    setStatus(e?.message || 'Failed loading issues');
  }
}

async function createIssue() {
  const token = tokenEl.value.trim();
  const title = issueTitleEl.value.trim();
  const body = issueBodyEl.value.trim();
  if (!token) return setStatus('Add token first');
  if (!selectedRepo) return setStatus('Select repo first');
  if (!title) return setStatus('Issue title is required');

  setStatus('Creating issue...');
  try {
    const out = await gh<{ html_url: string; number: number }>(`/repos/${selectedRepo.full_name}/issues`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    issueTitleEl.value = '';
    issueBodyEl.value = '';
    setStatus(`Created #${out.number}`);
    await loadIssues();
  } catch (e: any) {
    setStatus(e?.message || 'Failed creating issue');
  }
}

function stopOAuthPolling(resetHint = true) {
  oauthPollingAbort = true;
  oauthPendingDeviceCode = '';
  oauthVerifyUrl = '';
  oauthCancelEl.style.display = 'none';
  if (resetHint) {
    oauthHintRowEl.style.display = 'none';
    oauthUserCodeEl.textContent = '-';
  }
}

async function postForm<T>(url: string, data: Record<string, string>): Promise<T> {
  const body = new URLSearchParams(data);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = JSON.parse(text || '{}');
  } catch {
    throw new Error(`Unexpected response from ${url}`);
  }
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `HTTP ${res.status}`);
  }
  return json as T;
}

async function oauthDeviceLogin() {
  const clientId = oauthClientIdEl.value.trim();
  if (!clientId) {
    setStatus('Enter OAuth App Client ID first');
    return;
  }

  try {
    setStatus('Requesting GitHub device code...');
    oauthPollingAbort = false;
    oauthCancelEl.style.display = 'inline-block';

    const code = await postForm<DeviceCodeResponse>('https://github.com/login/device/code', {
      client_id: clientId,
      scope: 'repo read:user',
    });

    oauthPendingDeviceCode = code.device_code;
    oauthVerifyUrl = code.verification_uri_complete || code.verification_uri;
    oauthUserCodeEl.textContent = code.user_code;
    oauthHintRowEl.style.display = 'flex';

    (window as any).open(oauthVerifyUrl, '_blank', 'noopener,noreferrer');
    setStatus('Finish login in the opened GitHub page, then waiting for token...');

    const intervalMs = Math.max(5, code.interval || 5) * 1000;
    const expiresAt = Date.now() + code.expires_in * 1000;

    while (!oauthPollingAbort && Date.now() < expiresAt) {
      await new Promise((r) => setTimeout(r, intervalMs));

      const out = await postForm<DeviceTokenResponse>('https://github.com/login/oauth/access_token', {
        client_id: clientId,
        device_code: oauthPendingDeviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });

      if (out.access_token) {
        tokenEl.value = out.access_token;
        await saveConfig({ token: out.access_token, oauthClientId: clientId });
        stopOAuthPolling();
        setStatus('GitHub login successful — token saved');
        await loadRepos();
        (window as any).yaar?.app?.sendInteraction?.({ event: 'oauth_login_success' });
        return;
      }

      if (out.error === 'authorization_pending') {
        continue;
      }
      if (out.error === 'slow_down') {
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      if (out.error === 'expired_token') {
        stopOAuthPolling();
        setStatus('Login timed out. Please try again.');
        return;
      }

      throw new Error(out.error_description || out.error || 'OAuth failed');
    }

    if (!oauthPollingAbort) {
      stopOAuthPolling();
      setStatus('Login canceled or expired');
    }
  } catch (e: any) {
    stopOAuthPolling(false);
    setStatus(`OAuth failed: ${e?.message || 'unknown error'} (PAT still works)`);
  }
}

(document.getElementById('saveToken') as HTMLButtonElement).onclick = async () => {
  const token = tokenEl.value.trim();
  if (!token) return setStatus('Token is empty');
  await saveConfig({ token, oauthClientId: oauthClientIdEl.value.trim() || undefined });
  setStatus('Token saved locally');
};

(document.getElementById('loadRepos') as HTMLButtonElement).onclick = () => loadRepos();
(document.getElementById('refreshIssues') as HTMLButtonElement).onclick = () => loadIssues();
(document.getElementById('createIssue') as HTMLButtonElement).onclick = () => createIssue();
(document.getElementById('oauthLogin') as HTMLButtonElement).onclick = () => oauthDeviceLogin();
oauthCancelEl.onclick = () => {
  stopOAuthPolling();
  setStatus('OAuth login canceled');
};
openVerifyEl.onclick = () => {
  if (!oauthVerifyUrl) return;
  (window as any).open(oauthVerifyUrl, '_blank', 'noopener,noreferrer');
};
filterEl.oninput = () => renderRepos();

async function init() {
  const cfg = await loadConfig();
  if (cfg.token) {
    tokenEl.value = cfg.token;
    setStatus('Loaded saved token');
  }
  if (cfg.oauthClientId) {
    oauthClientIdEl.value = cfg.oauthClientId;
  }
  renderRepos();
  renderSelectedRepo();
  renderIssues();
}

init();

const appApi = (window as any).yaar?.app;
if (appApi) {
  appApi.register({
    appId: 'github-manager',
    name: 'GitHub Manager',
    state: {
      viewer: {
        description: 'Current authenticated viewer login',
        handler: () => viewerLogin,
      },
      repos: {
        description: 'Loaded repositories',
        handler: () => [...repos],
      },
      selectedRepo: {
        description: 'Currently selected repo full name',
        handler: () => selectedRepo?.full_name ?? null,
      },
      issues: {
        description: 'Loaded issues for selected repo',
        handler: () => [...issues],
      },
    },
    commands: {
      refreshRepos: {
        description: 'Load repositories from GitHub API',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await loadRepos();
          return { ok: true, count: repos.length };
        },
      },
      selectRepo: {
        description: 'Select a repo by full name and load issues',
        params: {
          type: 'object',
          properties: { fullName: { type: 'string' } },
          required: ['fullName'],
        },
        handler: async (p: { fullName: string }) => {
          const hit = repos.find((r) => r.full_name === p.fullName);
          if (!hit) throw new Error('Repo not found');
          selectedRepo = hit;
          renderRepos();
          renderSelectedRepo();
          await loadIssues();
          return { ok: true };
        },
      },
      createIssue: {
        description: 'Create an issue in the selected repo',
        params: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['title'],
        },
        handler: async (p: { title: string; body?: string }) => {
          issueTitleEl.value = p.title;
          issueBodyEl.value = p.body ?? '';
          await createIssue();
          return { ok: true };
        },
      },
    },
  });
}
