/**
 * The post-stop debris gate.
 *
 * Interrupting an agent stops the *agent*; it does not stop the tool calls it already
 * dispatched. Those run to completion on the MCP server and emit their actions through
 * `emitAction`, which knows nothing about turns — so a window created a beat before the
 * stop still opened after it, and the user who pressed stop watched the screen keep
 * changing.
 *
 * An id lands here on interrupt and leaves on the agent's next turn or its disposal
 * (`AgentSession.interrupt` / `handleMessage` / `cleanup`), so the block covers exactly
 * the tail of the stopped turn and nothing else.
 *
 * Lifted out of `ActionEmitter` because it is neither an emitter concern nor a pending
 * request: it is one set of agent ids with two external mutators, and every emit path
 * consults it.
 */
export class InterruptGate {
  private interrupted = new Set<string>();

  /** This agent's turn was stopped: drop the actions its in-flight tools still emit. */
  mark(agentId: string): void {
    this.interrupted.add(agentId);
  }

  /** This agent is running again (or gone): stop dropping its actions. */
  clear(agentId: string): void {
    this.interrupted.delete(agentId);
  }

  /**
   * Whether an action attributed to this agent should be dropped as post-stop debris.
   *
   * Only actions attributable to an agent are ever dropped. An action with no agent in
   * context comes from an iframe verb call or an HTTP route — the user clicking
   * something — and a stopped agent is no reason to ignore the user.
   */
  blocks(agentId: string | undefined): boolean {
    return !!agentId && this.interrupted.has(agentId);
  }
}
