/**
 * DesktopStatusBar - Connection status bar and expandable agent panel.
 *
 * The bar is a **census**, not a report: one small chip per live agent, showing which
 * monitor it works for and — by color alone — which tier it belongs to. It used to show
 * each agent's current status text ("Running: Bash", "Subagent (server): …"), which is
 * the right level of detail for one agent and unreadable for several: four of them
 * overflowed the pill, and the pool admits ten (`MAX_AGENTS`) plus sub-agents under
 * them. The status text still exists, one hover or one click away, in the panel below.
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

/**
 * The chip's own, much later threshold.
 *
 * The elapsed counter is what tells a streaming phase from a silent one ({@link
 * ActiveAgent.statusSince}) — the reason it is on screen at all. But a chip is three
 * characters wide, and at the panel's 3s it would be showing a number essentially
 * always, which is the width problem this bar was rebuilt to escape. So the chip stays
 * bare through the range where a phase is merely *taking a while*, and grows the number
 * only once the silence is worth interrupting over. The panel keeps the sensitive
 * threshold for whoever opened it to look.
 */
const CHIP_ELAPSED_VISIBLE_AFTER_MS = 30000;

/** Re-render cadence while any agent is active. Matches the 1s resolution shown. */
const TICK_MS = 1000;

/**
 * How many chips the pill shows before collapsing the rest into a count. Ten is
 * `MAX_AGENTS`, and sub-agents run under that same ceiling, so this is reached only by a
 * desktop that is genuinely saturated — at which point "+3" says as much as three more
 * chips would.
 */
const MAX_CHIPS = 10;

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
function elapsedLabel(agent: ActiveAgent, now: number, threshold = ELAPSED_VISIBLE_AFTER_MS) {
  const elapsed = now - agent.statusSince;
  return elapsed >= threshold ? formatElapsed(elapsed) : null;
}

/**
 * What the chip says: the monitor the agent is working for.
 *
 * The session agent is the one tier that belongs to no monitor — it is the user's deputy
 * for the whole session — so it gets a letter rather than a number. `·` is the agent
 * whose event carried no monitorId at all, which should not happen and is drawn rather
 * than hidden if it does.
 */
function chipLabel(agent: ActiveAgent): string {
  if (agent.monitorId) return agent.monitorId;
  return agent.kind === 'session' ? 'S' : '·';
}

/** The detail the chip drops, restored on hover. */
function chipTitle(agent: ActiveAgent, now: number): string {
  const where = agent.monitorId ? `monitor ${agent.monitorId}` : agent.kind;
  const elapsed = elapsedLabel(agent, now);
  const subs = agent.subagentCount > 0 ? ` (+${agent.subagentCount} sub)` : '';
  return `${agent.kind} · ${where} — ${agent.status}${elapsed ? ` ${elapsed}` : ''}${subs}`;
}

/**
 * Chips in a stable order: monitor first, so an agent's neighbours are the other agents
 * on its desktop, then tier, then id. Ordering by arrival instead would reshuffle the
 * row every time a turn ended.
 */
function chipOrder(a: ActiveAgent, b: ActiveAgent): number {
  return (
    (a.monitorId ?? '~').localeCompare(b.monitorId ?? '~') ||
    a.kind.localeCompare(b.kind) ||
    a.id.localeCompare(b.id)
  );
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

  const agentList = Object.values(activeAgents).sort(chipOrder);
  const chips = agentList.slice(0, MAX_CHIPS);
  const hidden = agentList.length - chips.length;

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
              {chips.map((agent) => {
                const stalled = elapsedLabel(agent, now, CHIP_ELAPSED_VISIBLE_AFTER_MS);
                return (
                  <span
                    key={agent.id}
                    className={styles.agentChip}
                    data-kind={agent.kind}
                    title={chipTitle(agent, now)}
                  >
                    <span className={styles.agentChipDot} />
                    <span className={styles.agentChipLabel}>{chipLabel(agent)}</span>
                    {agent.subagentCount > 0 && (
                      <span className={styles.agentChipSubs}>+{agent.subagentCount}</span>
                    )}
                    {stalled && <span className={styles.agentChipElapsed}>{stalled}</span>}
                  </span>
                );
              })}
              {hidden > 0 && <span className={styles.agentChipMore}>+{hidden}</span>}
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
        </div>
      )}
    </>
  );
}
