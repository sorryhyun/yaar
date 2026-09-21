/**
 * AgentStatus - the two readings the shell takes of the agent pool, apart from the
 * surface that happens to be showing them.
 *
 * On a desktop both live in the status pill at the top of the screen
 * (`DesktopStatusBar`). A phone has no room for a permanent pill — a strip that says
 * "Connected" forever is the one thing on a 412px screen that is never worth its pixels
 * — so the same two readings are shown inside the pull-down shade instead
 * (`NotificationShade`). They live here so the two surfaces cannot drift into saying
 * different things about the same pool.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopStore, type DesktopStore } from '@/store';
import type { ActiveAgent } from '@/types/state';
import styles from '@/styles/desktop/DesktopSurface.module.css';

/**
 * Below this, the phase is not worth timing — the label would flicker "0s/1s/2s" through
 * the tool churn of a healthy turn and train the eye to ignore it. The number exists to
 * be alarming, so it only appears once a phase has lasted longer than one plausibly does.
 */
export const ELAPSED_VISIBLE_AFTER_MS = 3000;

/** Re-render cadence while any agent is active. Matches the 1s resolution shown. */
const TICK_MS = 1000;

/** `8s`, `1m04s` — narrow enough to sit in a status bar without reflowing it. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

/**
 * How long the agent has been in its current phase, or null while that is too short to
 * be worth saying.
 *
 * The status label is last-event-wins with no heartbeat behind it (see {@link
 * ActiveAgent.statusSince}), so a phase that has gone quiet renders exactly like one that
 * is streaming. This is the only thing on screen that tells them apart.
 */
export function elapsedLabel(
  agent: ActiveAgent,
  now: number,
  threshold = ELAPSED_VISIBLE_AFTER_MS,
): string | null {
  const elapsed = now - agent.statusSince;
  return elapsed >= threshold ? formatElapsed(elapsed) : null;
}

/**
 * Agents in a stable order: monitor first, so an agent's neighbours are the other agents
 * on its desktop, then tier, then id. Ordering by arrival instead would reshuffle the
 * row every time a turn ended.
 */
export function chipOrder(a: ActiveAgent, b: ActiveAgent): number {
  return (
    (a.monitorId ?? '~').localeCompare(b.monitorId ?? '~') ||
    a.kind.localeCompare(b.kind) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * A clock that ticks only while `active`, for the elapsed counters to read.
 *
 * An idle desktop schedules nothing; `active` is a boolean rather than the agent list,
 * or every status change would tear the interval down and restart the second.
 */
export function useElapsedNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** The dot and the word: whether there is an agent process to talk to at all. */
export function ConnectionStatus() {
  const { t } = useTranslation();
  const connectionStatus = useDesktopStore((s) => s.connectionStatus);
  const providerType = useDesktopStore((s) => s.providerType);

  return (
    <>
      <span className={styles.statusDot} data-status={connectionStatus} />
      <span className={styles.statusText}>
        {connectionStatus === 'connected'
          ? t('status.connected', { provider: providerType || 'agent' })
          : connectionStatus === 'connecting'
            ? t('status.connecting')
            : t('status.disconnected')}
      </span>
    </>
  );
}

/** The title of the window each window agent belongs to, keyed by agent id. */
function selectAgentWindowTitles(state: DesktopStore): Record<string, string | undefined> {
  const titles: Record<string, string | undefined> = {};
  for (const [agentId, { windowId }] of Object.entries(state.windowAgents)) {
    titles[agentId] = state.windows[windowId]?.title;
  }
  return titles;
}

interface AgentRosterProps {
  interrupt: () => void;
  interruptAgent: (agentId: string) => void;
}

/**
 * One row per live agent: what it is, what it is doing, and the button that stops it.
 *
 * Renders nothing when the pool is empty, so a caller can drop it into a sheet without
 * guarding it. It keeps its own ticker rather than taking `now` as a prop — the desktop
 * panel that wraps it already has one, but a second 1s interval for the seconds a panel
 * is open is cheaper than making every caller own a clock.
 */
export function AgentRoster({ interrupt, interruptAgent }: AgentRosterProps) {
  const { t } = useTranslation();
  const activeAgents = useDesktopStore((s) => s.activeAgents);
  // Titles only, compared shallowly: subscribing to `windows` itself re-rendered the
  // roster on every mousemove of a window drag.
  const windowTitles = useDesktopStore(useShallow(selectAgentWindowTitles));

  const agentList = Object.values(activeAgents).sort(chipOrder);
  const now = useElapsedNow(agentList.length > 0);

  if (agentList.length === 0) return null;

  return (
    <>
      <div className={styles.agentPanelHeader}>
        <span>{t('status.activeAgents')}</span>
        <button className={styles.stopAllButton} onClick={interrupt} title={t('status.stopAll')}>
          {t('status.stopAll')}
        </button>
      </div>
      <div className={styles.agentPanelList}>
        {agentList.map((agent) => {
          const windowTitle = windowTitles[agent.id];

          return (
            <div key={agent.id} className={styles.agentPanelItem}>
              {/* Same color axis as the chip, so a row can be matched back to the
                  chip that led the user to open the panel. */}
              <span className={styles.agentChipDot} data-kind={agent.kind} />
              <div className={styles.agentPanelInfo}>
                <span className={styles.agentPanelId}>{agent.id}</span>
                <span className={styles.agentPanelStatus}>{agent.status}</span>
                {elapsedLabel(agent, now) && (
                  <span className={styles.agentElapsed}>{elapsedLabel(agent, now)}</span>
                )}
                {agent.subagentCount > 0 && (
                  <span className={styles.agentPanelSubagents}>
                    {t('status.subagents', { count: agent.subagentCount })}
                  </span>
                )}
                {windowTitle && (
                  <span className={styles.agentPanelWindow}>
                    {t('status.window', { title: windowTitle })}
                  </span>
                )}
              </div>
              <button
                className={styles.stopAgentButton}
                onClick={() => interruptAgent(agent.id)}
                title={t('status.stopAgent', { agentId: agent.id })}
              >
                {t('status.stop')}
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
