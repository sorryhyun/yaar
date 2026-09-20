/**
 * DesktopStatusBar - Connection status bar and expandable agent panel.
 *
 * The bar is a **census**, not a report: one small chip per live agent, showing which
 * monitor it works for and — by color alone — which tier it belongs to. It used to show
 * each agent's current status text ("Running: Bash", "Subagent (server): …"), which is
 * the right level of detail for one agent and unreadable for several: four of them
 * overflowed the pill, and the pool admits ten (`MAX_AGENTS`) plus sub-agents under
 * them. The status text still exists, one hover or one click away, in the panel below.
 *
 * None of it is on screen on a phone. A pill pinned to the top edge costs a strip of a
 * 412px screen for the whole session to say "Connected", and a dot that is there
 * whatever the user is doing is the kind of chrome a phone has no room for — so the
 * phone shows all of this, the connection reading included, in the pull-down shade
 * instead (`NotificationShade`). Nothing stays behind, not even for a disconnection:
 * the pull-down is the one place a phone reports on itself.
 */
import { useDesktopStore } from '@/store';
import type { ActiveAgent } from '@/types/state';
import {
  AgentRoster,
  ConnectionStatus,
  chipOrder,
  elapsedLabel,
  useElapsedNow,
} from './AgentStatus';
import styles from '@/styles/desktop/DesktopSurface.module.css';

interface DesktopStatusBarProps {
  interrupt: () => void;
  interruptAgent: (agentId: string) => void;
}

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

/**
 * How many chips the pill shows before collapsing the rest into a count. Ten is
 * `MAX_AGENTS`, and sub-agents run under that same ceiling, so this is reached only by a
 * desktop that is genuinely saturated — at which point "+3" says as much as three more
 * chips would.
 */
const MAX_CHIPS = 10;

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

export function DesktopStatusBar({ interrupt, interruptAgent }: DesktopStatusBarProps) {
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  const activeAgents = useDesktopStore((s) => s.activeAgents);
  const agentPanelOpen = useDesktopStore((s) => s.agentPanelOpen);
  const toggleAgentPanel = useDesktopStore((s) => s.toggleAgentPanel);

  const agentList = Object.values(activeAgents).sort(chipOrder);
  const chips = agentList.slice(0, MAX_CHIPS);
  const hidden = agentList.length - chips.length;

  const now = useElapsedNow(agentList.length > 0);

  // The phone's rule, in one place: this bar is a desktop thing. Everything it would
  // have said is a pull-down away.
  if (isMobile) return null;
  const census = agentList.length > 0;

  return (
    <>
      {/* Connection status indicator */}
      <div className={styles.statusBar}>
        <ConnectionStatus />
        {census && (
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
      {census && agentPanelOpen && (
        <div className={styles.agentPanel}>
          <AgentRoster interrupt={interrupt} interruptAgent={interruptAgent} />
        </div>
      )}
    </>
  );
}
