import { createSignal, onMount, For, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { readJson, invoke, del } from '@bundled/yaar';
import { showToast } from '../store';
import type { DomainsData } from '../types';
import { onInputHandler } from '../helpers';

export function DomainsView() {
  const [data, setData] = createSignal<DomainsData>({ allow_all_domains: false, allowed_domains: [] });
  const [loading, setLoading] = createSignal(true);
  const [newDomain, setNewDomain] = createSignal('');
  const [adding, setAdding] = createSignal(false);

  const load = async () => {
    try {
      const raw = await readJson<DomainsData>('yaar://config/domains');
      setData(raw);
    } catch {
      showToast('Failed to load domains', 'error');
    } finally {
      setLoading(false);
    }
  };

  onMount(load);

  const toggleAllowAll = async () => {
    const next = !data().allow_all_domains;
    try {
      await invoke('yaar://config/domains', { allowAll: next });
      setData(d => ({ ...d, allow_all_domains: next }));
      showToast(next ? 'All domains allowed' : 'Domain allowlist enabled');
    } catch {
      showToast('Failed to update setting', 'error');
    }
  };

  const addDomain = async () => {
    const domain = newDomain().trim();
    if (!domain) return;
    setAdding(true);
    try {
      await invoke('yaar://config/domains', { domain });
      setNewDomain('');
      showToast(`"${domain}" added — check permission dialog`);
      await load();
    } catch {
      showToast('Failed to add domain', 'error');
    } finally {
      setAdding(false);
    }
  };

  const removeDomain = async (domain: string) => {
    try {
      await del(`yaar://config/domains/${domain}`);
      setData(d => ({ ...d, allowed_domains: d.allowed_domains.filter(x => x !== domain) }));
      showToast(`"${domain}" removed`);
    } catch {
      showToast('Failed to remove domain', 'error');
    }
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') addDomain();
  };

  return html`
    <div class="settings-wrapper">
      ${() => loading() ? html`
        <div style="display:flex;align-items:center;justify-content:center;height:120px;">
          <div class="y-spinner"></div>
        </div>
      ` : html`
        <div class="s-section">
          <div class="s-section-title">🌐 Access Control</div>
          <div class="s-row s-row-toggle">
            <div>
              <label class="s-label">Allow All Domains</label>
              <div class="s-hint-block">
                ${() => data().allow_all_domains
                  ? '⚠️ All HTTP domains are allowed — use with caution'
                  : 'Only explicitly allowlisted domains can be fetched via the proxy'}
              </div>
            </div>
            <button
              class=${() => `s-toggle ${data().allow_all_domains ? 'on' : ''}`}
              onClick=${toggleAllowAll}
              role="switch"
              aria-checked=${() => String(data().allow_all_domains)}
            >
              <span class="s-toggle-thumb"></span>
            </button>
          </div>
        </div>

        <div class="s-section" style=${() => data().allow_all_domains ? 'opacity:0.5;pointer-events:none;' : ''}>
          <div class="s-section-title" style="display:flex;align-items:center;justify-content:space-between;">
            <span>📋 Allowed Domains</span>
            <span class="item-badge">${() => data().allowed_domains.length} domains</span>
          </div>

          <div style="display:flex;gap:8px;margin-bottom:12px;">
            <input
              class="s-input"
              style="flex:1;width:auto;"
              type="text"
              placeholder="api.example.com"
              value=${newDomain}
              onInput=${onInputHandler(setNewDomain)}
              onKeydown=${handleKeydown}
            />
            <button
              class="y-btn y-btn-primary y-btn-sm"
              onClick=${addDomain}
              disabled=${() => adding() || !newDomain().trim()}
            >
              ${() => adding() ? '…' : '+ Add'}
            </button>
          </div>

          ${() => data().allowed_domains.length === 0 ? html`
            <div style="text-align:center;padding:20px 0;color:var(--yaar-text-muted);font-size:12px;">
              No domains allowlisted
            </div>
          ` : html`
            <div class="domain-list">
              <${For} each=${() => data().allowed_domains}>${(domain: string) => html`
                <div class="domain-item">
                  <span class="domain-name">🔗 ${domain}</span>
                  <button
                    class="y-btn y-btn-ghost y-btn-sm domain-del"
                    onClick=${() => removeDomain(domain)}
                    title="Remove"
                  >✕</button>
                </div>
              `}</${For}>
            </div>
          `}
        </div>
      `}
    </div>
  `;
}
