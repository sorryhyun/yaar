/**
 * DesktopStatusBar - Connection status bar and expandable agent panel.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopStore } from '@/store';
import type { ActiveAgent } from '@/types/state';
import styles from '@/styles/desktop/DesktopSurface.module.css';

interface DesktopStatusBarProps {
  interrupt: () => void;
  interruptAgent: (agentId: string) => void;
}

/**
 * Below this, the phase is not worth timing — the label would flicker "0s/1s/2s" through
 * the tool churn of a healthy turn and train the eye to ignore it. The number exists to
 * be alarming, so it only appears once a phase has lasted longer than one plausibly does.
 */
const ELAPSED_VISIBLE_AFTER_MS = 3000;

/** Re-render cadence while any agent is active. Matches the 1s resolution shown. */
const TICK_MS = 1000;

/** `8s`, `1m04s` — narrow enough to sit in a status bar without reflowing it. */
function formatElapsed(ms: number): string {
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
function elapsedLabel(agent: ActiveAgent, now: number): string | null {
  const elapsed = now - agent.statusSince;
  return elapsed >= ELAPSED_VISIBLE_AFTER_MS ? formatElapsed(elapsed) : null;
}

export function DesktopStatusBar({ interrupt, interruptAgent }: DesktopStatusBarProps) {
  const { t } = useTranslation();
  const connectionStatus = useDesktopStore((s) => s.connectionStatus);
  const providerType = useDesktopStore((s) => s.providerType);
  const activeAgents = useDesktopStore((s) => s.activeAgents);
  const agentPanelOpen = useDesktopStore((s) => s.agentPanelOpen);
  const toggleAgentPanel = useDesktopStore((s) => s.toggleAgentPanel);
  const windows = useDesktopStore((s) => s.windows);
  const windowAgents = useDesktopStore((s) => s.windowAgents);

  const agentList = Object.values(activeAgents);

  // Drives the elapsed counters. Runs only while something is active, so an idle desktop
  // schedules nothing; `agentList.length` (not the array) is the dependency, or every
  // status change would tear the interval down and restart the second.
  const [now, setNow] = useState(() => Date.now());
  const hasAgents = agentList.length > 0;
  useEffect(() => {
    if (!hasAgents) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [hasAgents]);

  return (
    <>
      {/* Connection status indicator */}
      <div className={styles.statusBar}>
        <span className={styles.statusDot} data-status={connectionStatus} />
        <span className={styles.statusText}>
          {connectionStatus === 'connected'
            ? t('status.connected', { provider: providerType || 'agent' })
            : connectionStatus === 'connecting'
              ? t('status.connecting')
              : t('status.disconnected')}
        </span>
        {agentList.length > 0 && (
          <>
            <span className={styles.statusDivider} />
            <button
              className={styles.agentIndicatorButton}
              onClick={toggleAgentPanel}
              title="Click to expand agent panel"
            >
              {agentList.map((agent) => (
                <div key={agent.id} className={styles.agentIndicator}>
                  <span className={styles.agentSpinner} />
                  <span className={styles.agentStatus}>{agent.status}</span>
                  {elapsedLabel(agent, now) && (
                    <span className={styles.agentElapsed}>{elapsedLabel(agent, now)}</span>
                  )}
                  {agent.subagentCount > 0 && (
                    <span className={styles.subagentBadge}>+{agent.subagentCount} sub</span>
                  )}
                </div>
              ))}
              <span className={styles.expandArrow} data-open={agentPanelOpen}>
                {agentPanelOpen ? '▲' : '▼'}
              </span>
            </button>
          </>
        )}
      </div>

      {/* Expanded agent panel */}
      {agentPanelOpen && agentList.length > 0 && (
        <div className={styles.agentPanel}>
          <div className={styles.agentPanelHeader}>
            <span>{t('status.activeAgents')}</span>
            <button
              className={styles.stopAllButton}
              onClick={interrupt}
              title={t('status.stopAll')}
            >
              {t('status.stopAll')}
            </button>
          </div>
          <div className={styles.agentPanelList}>
            {agentList.map((agent) => {
              // Find window associated with this agent (keyed by agentId)
              const windowAgent = windowAgents[agent.id];
              const windowId = windowAgent?.windowId;
              const windowTitle = windowId ? windows[windowId]?.title : null;

              return (
                <div key={agent.id} className={styles.agentPanelItem}>
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
        </div>
      )}
    </>
  );
}
