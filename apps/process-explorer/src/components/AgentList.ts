export {};

import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { agentActivity, agentList, interruptAgent, now } from '../data';
import { AGENT_TIER } from '../constants';
import { formatAge, formatUsage } from '../format';
import { TURN_STATE_STYLE, agentTierColor, statusDotClass } from '../theme';
import type { AgentEntry } from '../types';
import { ProcessList } from './ProcessList';

function AgentRow(props: { agent: AgentEntry }) {
  const a = () => props.agent;

  // Busy means a turn is in flight; ephemeral means a short-lived agent holding a
  // slot. Both are worth a glance, and nothing else is.
  const dotClass = () => statusDotClass(a().busy || a().type === AGENT_TIER.ephemeral);

  // Live activity, folded from the agent's stream: an explicit turn state, the
  // tool line, a tail of text, and how long since the last frame.
  const act = () => agentActivity[a().id];
  const toolText = () => {
    const t = act()?.tool;
    return t ? `${t.name} · ${t.status}` : '';
  };
  const bodyText = () => act()?.text ?? '';
  const stateStyle = () => {
    const state = act()?.state;
    return state ? TURN_STATE_STYLE[state] : null;
  };
  const stateLabel = () => {
    const activity = act();
    if (!activity) return '';
    // An interrupted turn reads as its own outcome, not a plain `done`.
    if (activity.state === 'done' && activity.endStatus === 'interrupted') return 'interrupted';
    return TURN_STATE_STYLE[activity.state].label;
  };
  const ageText = () => {
    const at = act()?.updatedAt;
    return at ? formatAge(at, now()) : '';
  };
  const errorText = () => act()?.error ?? '';

  // The stream's figure when we have one, the roster's otherwise. Both are the
  // agent's lifetime total; the stream just gets there first, between polls.
  const usageText = () => formatUsage(act()?.usage ?? a().usage);

  return html`
    <div class="process-row">
      <div class="process-info">
        <span class=${dotClass}></span>
        <div class="process-detail">
          <div class="process-title">${() => a().label}</div>
          <div class="process-meta">
            <span style=${() => `color: ${agentTierColor(a().type)}`}>${() => a().type}</span>
            <span>${() => (a().busy ? 'busy' : 'idle')}</span>
            <${Show} when=${usageText}>
              <span class="meta-tokens" title="Input + output tokens. Cache reads excluded; cache writes count as input."
                >${usageText}</span
              >
            </>
          </div>
          <${Show} when=${() => act() !== undefined}>
            <div class="process-activity">
              <div class="activity-state">
                <span class="activity-badge" style=${() => `color: ${stateStyle()?.color ?? ''}`}
                  >${stateLabel}</span
                >
                <span class="activity-age">${ageText}</span>
              </div>
              <${Show} when=${toolText}>
                <span class="activity-tool y-truncate">${toolText}</span>
              </>
              <${Show} when=${errorText}>
                <span class="activity-error y-truncate">${errorText}</span>
              </>
              <${Show} when=${bodyText}>
                <span class="activity-text y-truncate">${bodyText}</span>
              </>
            </div>
          </>
        </div>
      </div>
      <div class="process-actions">
        <button
          class="y-btn y-btn-ghost btn-sm btn-danger"
          onClick=${() => interruptAgent(a().id)}
          title="Interrupt"
        >
          Stop
        </button>
      </div>
    </div>
  `;
}

export function AgentList() {
  return html`
    <${ProcessList} each=${agentList} icon="~" emptyText="No agents running"
      >${(agent: AgentEntry) => html`<${AgentRow} agent=${agent} />`}</
    >
  `;
}
