type Draft = {
  to: string;
  subject: string;
  body: string;
};

type Provider = 'smtp' | 'google';

const STORAGE_PATH = 'smtp-mailer/draft.json';

const root = document.createElement('div');
root.style.fontFamily = 'Inter, system-ui, sans-serif';
root.style.padding = '16px';
root.style.maxWidth = '920px';
root.style.margin = '0 auto';
root.innerHTML = `
  <h2 style="margin:0 0 8px">SMTP Mailer</h2>
  <p style="margin:0 0 16px;color:#666">Compose email with SMTP or Google API.</p>

  <section style="border:1px solid #ddd;border-radius:10px;padding:12px;margin-bottom:12px">
    <h3 style="margin:0 0 10px;font-size:15px">Provider</h3>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <select id="providerSelect" style="padding:8px;border:1px solid #ccc;border-radius:8px;background:#fff">
        <option value="smtp">SMTP</option>
        <option value="google">Google API</option>
      </select>
      <span id="providerStatus" style="font-size:12px;color:#666">Using SMTP mode</span>
    </div>
  </section>

  <section id="smtpSection" style="border:1px solid #ddd;border-radius:10px;padding:12px;margin-bottom:12px">
    <h3 style="margin:0 0 10px;font-size:15px">SMTP Profile</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:#555">
        Host
        <input id="smtpHost" value="smtp.gmail.com" style="padding:8px;border:1px solid #ccc;border-radius:8px" />
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:#555">
        Port
        <input id="smtpPort" value="465" style="padding:8px;border:1px solid #ccc;border-radius:8px" />
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:#555">
        Username
        <input id="smtpUser" value="standingbehindnv@gmail.com" style="padding:8px;border:1px solid #ccc;border-radius:8px" />
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:#555">
        App Password
        <input id="smtpPass" type="password" placeholder="xxxx xxxx xxxx xxxx" style="padding:8px;border:1px solid #ccc;border-radius:8px" />
      </label>
    </div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button id="saveProfile" style="padding:8px 12px;border-radius:8px;border:1px solid #0a7;background:#0a7;color:#fff">Save SMTP Profile</button>
      <span id="profileStatus" style="font-size:12px;color:#666;align-self:center"></span>
    </div>
  </section>

  <section id="googleSection" style="display:none;border:1px solid #ddd;border-radius:10px;padding:12px;margin-bottom:12px;background:#fcfcff">
    <h3 style="margin:0 0 10px;font-size:15px">Google Auth</h3>
    <p style="margin:0 0 8px;color:#666;font-size:12px">Authenticate in browser, then token is saved by agent.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <button id="authenticateGoogle" style="padding:8px 12px;border-radius:8px;border:1px solid #2563eb;background:#2563eb;color:#fff">Authenticate Google</button>
      <button id="requestAuthLink" style="padding:8px 12px;border-radius:8px;border:1px solid #ccc;background:#fff">Get Manual Auth Link</button>
    </div>

    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:#555;margin-bottom:8px">
      Auth Link (manual fallback)
      <input id="googleAuthLink" readonly placeholder="Click 'Get Manual Auth Link'" style="padding:8px;border:1px solid #ccc;border-radius:8px;background:#f8f8f8" />
    </label>

    <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;margin-bottom:8px">
      <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:#555">
        Paste authorization code
        <input id="googleAuthCode" placeholder="4/0AfJohX..." style="padding:8px;border:1px solid #ccc;border-radius:8px" />
      </label>
      <button id="submitGoogleCode" style="padding:8px 12px;border-radius:8px;border:1px solid #0a7;background:#0a7;color:#fff;height:36px">Submit Code</button>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <span id="googleStatus" style="font-size:12px;color:#666">Not connected</span>
    </div>
  </section>

  <section style="border:1px solid #ddd;border-radius:10px;padding:12px">
    <h3 style="margin:0 0 10px;font-size:15px">Compose</h3>
    <div style="display:flex;flex-direction:column;gap:8px">
      <input id="to" placeholder="To" style="padding:10px;border:1px solid #ccc;border-radius:8px" />
      <input id="subject" placeholder="Subject" style="padding:10px;border:1px solid #ccc;border-radius:8px" />
      <textarea id="body" placeholder="Write your email..." rows="10" style="padding:10px;border:1px solid #ccc;border-radius:8px;resize:vertical"></textarea>
    </div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button id="saveDraft" style="padding:8px 12px;border-radius:8px;border:1px solid #ccc;background:#fff">Save Draft</button>
      <button id="send" style="padding:8px 12px;border-radius:8px;border:1px solid #2563eb;background:#2563eb;color:#fff">Send Email</button>
      <span id="sendStatus" style="font-size:12px;color:#666;align-self:center"></span>
    </div>
  </section>
`;

document.body.style.margin = '0';
document.body.style.background = '#fafafa';
document.body.appendChild(root);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function currentProvider(): Provider {
  return (($('providerSelect') as HTMLSelectElement).value || 'smtp') as Provider;
}

function renderProviderUI(provider: Provider) {
  const smtpVisible = provider === 'smtp';
  ($('smtpSection') as HTMLElement).style.display = smtpVisible ? 'block' : 'none';
  ($('googleSection') as HTMLElement).style.display = smtpVisible ? 'none' : 'block';
  $('providerStatus').textContent = smtpVisible
    ? 'Using SMTP mode'
    : 'Using Google API mode';
}

async function loadDraft() {
  try {
    const data = (await (window as any).yaar.storage.read(STORAGE_PATH, { as: 'json' })) as Draft;
    if (data) {
      ($('to') as HTMLInputElement).value = data.to || '';
      ($('subject') as HTMLInputElement).value = data.subject || '';
      ($('body') as HTMLTextAreaElement).value = data.body || '';
    }
  } catch {}
}

async function saveDraft() {
  const draft: Draft = {
    to: ($('to') as HTMLInputElement).value.trim(),
    subject: ($('subject') as HTMLInputElement).value,
    body: ($('body') as HTMLTextAreaElement).value,
  };
  await (window as any).yaar.storage.save(STORAGE_PATH, JSON.stringify(draft, null, 2));
  $('sendStatus').textContent = `Draft saved at ${new Date().toLocaleTimeString()}`;
}

function smtpProfilePayload() {
  return {
    smtpHost: ($('smtpHost') as HTMLInputElement).value.trim(),
    smtpPort: Number(($('smtpPort') as HTMLInputElement).value || '465'),
    secure: Number(($('smtpPort') as HTMLInputElement).value || '465') === 465,
    username: ($('smtpUser') as HTMLInputElement).value.trim(),
    appPassword: ($('smtpPass') as HTMLInputElement).value,
  };
}

function composeDraft(): Draft {
  return {
    to: ($('to') as HTMLInputElement).value.trim(),
    subject: ($('subject') as HTMLInputElement).value,
    body: ($('body') as HTMLTextAreaElement).value,
  };
}

$('providerSelect').addEventListener('change', () => {
  const provider = currentProvider();
  renderProviderUI(provider);
  const appApi = (window as any).yaar?.app;
  appApi?.sendInteraction({
    event: 'mail_provider_changed',
    payload: { provider },
  });
});

$('saveDraft').addEventListener('click', async () => {
  await saveDraft();
});

$('saveProfile').addEventListener('click', () => {
  const payload = smtpProfilePayload();
  const appApi = (window as any).yaar?.app;
  appApi?.sendInteraction({ event: 'smtp_profile_save_requested', payload });
  $('profileStatus').textContent = 'Save requested to agent';
});

$('authenticateGoogle').addEventListener('click', () => {
  const appApi = (window as any).yaar?.app;
  appApi?.sendInteraction({
    event: 'google_authenticate_requested',
    payload: { mode: 'agent_browser' },
  });
  $('googleStatus').textContent = 'Opening auth flow in browser...';
});

$('requestAuthLink').addEventListener('click', () => {
  const appApi = (window as any).yaar?.app;
  appApi?.sendInteraction({
    event: 'google_auth_link_requested',
    payload: { mode: 'manual' },
  });
  $('googleStatus').textContent = 'Auth link requested from agent...';
});

$('submitGoogleCode').addEventListener('click', () => {
  const code = ($('googleAuthCode') as HTMLInputElement).value.trim();
  if (!code) {
    $('googleStatus').textContent = 'Please paste an authorization code first.';
    return;
  }
  const appApi = (window as any).yaar?.app;
  appApi?.sendInteraction({
    event: 'google_auth_code_submitted',
    payload: { code },
  });
  $('googleStatus').textContent = 'Code submitted to agent for token exchange...';
});

$('send').addEventListener('click', async () => {
  const draft = composeDraft();
  await saveDraft();
  const appApi = (window as any).yaar?.app;
  const provider = currentProvider();

  if (provider === 'google') {
    appApi?.sendInteraction({
      event: 'gmail_send_requested',
      payload: { draft },
    });
    $('sendStatus').textContent = 'Google send requested to agent';
    return;
  }

  appApi?.sendInteraction({
    event: 'smtp_send_requested',
    payload: {
      profile: smtpProfilePayload(),
      draft,
    },
  });
  $('sendStatus').textContent = 'SMTP send requested to agent';
});

const appApi = (window as any).yaar?.app;
if (appApi) {
  appApi.register({
    appId: 'smtp-mailer',
    name: 'SMTP Mailer',
    state: {
      provider: {
        description: 'Current send provider',
        handler: () => ({
          provider: currentProvider(),
        }),
      },
      compose: {
        description: 'Current compose fields',
        handler: () => composeDraft(),
      },
      smtpProfile: {
        description: 'Current SMTP profile form values',
        handler: () => ({
          smtpHost: ($('smtpHost') as HTMLInputElement).value,
          smtpPort: Number(($('smtpPort') as HTMLInputElement).value || '465'),
          username: ($('smtpUser') as HTMLInputElement).value,
          hasPassword: Boolean(($('smtpPass') as HTMLInputElement).value),
        }),
      },
      googleAuth: {
        description: 'Current Google auth UI state',
        handler: () => ({
          authLink: ($('googleAuthLink') as HTMLInputElement).value,
          hasAuthCode: Boolean(($('googleAuthCode') as HTMLInputElement).value.trim()),
          status: $('googleStatus').textContent || '',
        }),
      },
    },
    commands: {
      hydrateProfile: {
        description: 'Fill SMTP profile fields from saved config',
        params: {
          type: 'object',
          properties: {
            smtpHost: { type: 'string' },
            smtpPort: { type: 'number' },
            username: { type: 'string' },
          },
          required: [],
        },
        handler: (p: { smtpHost?: string; smtpPort?: number; username?: string }) => {
          if (p.smtpHost) ($('smtpHost') as HTMLInputElement).value = p.smtpHost;
          if (p.smtpPort) ($('smtpPort') as HTMLInputElement).value = String(p.smtpPort);
          if (p.username) ($('smtpUser') as HTMLInputElement).value = p.username;
          return { ok: true };
        },
      },
      setProvider: {
        description: 'Set active provider in UI',
        params: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['smtp', 'google'] },
          },
          required: ['provider'],
        },
        handler: (p: { provider: Provider }) => {
          ($('providerSelect') as HTMLSelectElement).value = p.provider;
          renderProviderUI(p.provider);
          return { ok: true };
        },
      },
      setGoogleAuthLink: {
        description: 'Set manual Google auth link in UI',
        params: {
          type: 'object',
          properties: {
            url: { type: 'string' },
          },
          required: ['url'],
        },
        handler: (p: { url: string }) => {
          ($('googleAuthLink') as HTMLInputElement).value = p.url;
          return { ok: true };
        },
      },
      setGoogleStatus: {
        description: 'Set Google auth status text',
        params: {
          type: 'object',
          properties: {
            status: { type: 'string' },
          },
          required: ['status'],
        },
        handler: (p: { status: string }) => {
          $('googleStatus').textContent = p.status;
          return { ok: true };
        },
      },
      setStatus: {
        description: 'Set status text for profile/send actions',
        params: {
          type: 'object',
          properties: {
            profileStatus: { type: 'string' },
            sendStatus: { type: 'string' },
            providerStatus: { type: 'string' },
          },
          required: [],
        },
        handler: (p: { profileStatus?: string; sendStatus?: string; providerStatus?: string }) => {
          if (typeof p.profileStatus === 'string') $('profileStatus').textContent = p.profileStatus;
          if (typeof p.sendStatus === 'string') $('sendStatus').textContent = p.sendStatus;
          if (typeof p.providerStatus === 'string') $('providerStatus').textContent = p.providerStatus;
          return { ok: true };
        },
      },
    },
  });
}

renderProviderUI('smtp');
loadDraft();
