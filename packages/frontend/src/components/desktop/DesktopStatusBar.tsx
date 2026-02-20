/**
 * DesktopStatusBar - Connection status bar and expandable agent panel.
 */
import { useDesktopStore } from '@/store';
import styles from '@/styles/desktop/DesktopSurface.module.css';

interface DesktopStatusBarProps {
  interrupt: () => void;
  interruptAgent: (agentId: string) => void;
}

export function DesktopStatusBar({ interrupt, interruptAgent }: DesktopStatusBarProps) {
  const connectionStatus = useDesktopStore((s) => s.connectionStatus);
  const providerType = useDesktopStore((s) => s.providerType);
  const activeAgents = useDesktopStore((s) => s.activeAgents);
  const agentPanelOpen = useDesktopStore((s) => s.agentPanelOpen);
  const toggleAgentPanel = useDesktopStore((s) => s.toggleAgentPanel);
  const windows = useDesktopStore((s) => s.windows);
  const windowAgents = useDesktopStore((s) => s.windowAgents);

  const agentList = Object.values(activeAgents);

  return (
    <>
      {/* Connection status indicator */}
      <div className={styles.statusBar}>
        <span className={styles.statusDot} data-status={connectionStatus} />
        <span className={styles.statusText}>
          {connectionStatus === 'connected'
            ? `Connected (${providerType || 'agent'})`
            : connectionStatus === 'connecting'
              ? 'Connecting...'
              : 'Disconnected'}
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
            <span>Active Agents</span>
            <button className={styles.stopAllButton} onClick={interrupt} title="Stop all agents">
              Stop All
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
                    {windowTitle && (
                      <span className={styles.agentPanelWindow}>Window: {windowTitle}</span>
                    )}
                  </div>
                  <button
                    className={styles.stopAgentButton}
                    onClick={() => interruptAgent(agent.id)}
                    title={`Stop agent ${agent.id}`}
                  >
                    Stop
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
