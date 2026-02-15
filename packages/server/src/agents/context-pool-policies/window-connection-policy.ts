/**
 * WindowConnectionPolicy — tracks window groups for agent reuse.
 *
 * When a window agent creates a new window, the child is "connected" to the parent's group.
 * All windows in a group share one agent. The group is identified by a stable groupId
 * (= the first window's ID, never changes even if that window later closes).
 */

export interface WindowCloseResult {
  /** True when the last window in the group (or a standalone window) closes. */
  shouldDisposeAgent: boolean;
  /** The new root window after promotion, if applicable. */
  newRoot?: string;
}

interface GroupInfo {
  windows: Set<string>;
  root: string;
}

export class WindowConnectionPolicy {
  /** Every connected window → its stable groupId. */
  private windowToGroup = new Map<string, string>();
  /** groupId → group metadata. */
  private groups = new Map<string, GroupInfo>();

  /**
   * Connect a child window to the parent's group.
   * If the parent is not yet in a group, a new group is created with the parent as root.
   */
  connectWindow(parentWindowId: string, childWindowId: string): void {
    let groupId = this.windowToGroup.get(parentWindowId);

    if (groupId === undefined) {
      // Parent is standalone — create a new group rooted at the parent
      groupId = parentWindowId;
      this.groups.set(groupId, {
        windows: new Set([parentWindowId]),
        root: parentWindowId,
      });
      this.windowToGroup.set(parentWindowId, groupId);
    }

    const group = this.groups.get(groupId)!;
    group.windows.add(childWindowId);
    this.windowToGroup.set(childWindowId, groupId);
  }

  /**
   * Get the groupId for a window, or undefined if standalone.
   */
  getGroupId(windowId: string): string | undefined {
    return this.windowToGroup.get(windowId);
  }

  /**
   * Get the current root of a window's group, or undefined if standalone.
   */
  getRoot(windowId: string): string | undefined {
    const groupId = this.windowToGroup.get(windowId);
    if (groupId === undefined) return undefined;
    return this.groups.get(groupId)?.root;
  }

  /**
   * Get all windows in a window's group, or undefined if standalone.
   */
  getGroupWindows(windowId: string): Set<string> | undefined {
    const groupId = this.windowToGroup.get(windowId);
    if (groupId === undefined) return undefined;
    const group = this.groups.get(groupId);
    return group ? new Set(group.windows) : undefined;
  }

  /**
   * Handle a window closing.
   * Removes the window from its group (if any), promotes root if needed,
   * and returns whether the agent should be disposed.
   */
  handleClose(windowId: string): WindowCloseResult {
    const groupId = this.windowToGroup.get(windowId);

    if (groupId === undefined) {
      // Standalone window — always dispose
      return { shouldDisposeAgent: true };
    }

    const group = this.groups.get(groupId)!;
    group.windows.delete(windowId);
    this.windowToGroup.delete(windowId);

    if (group.windows.size === 0) {
      // Last window in group — dispose agent and clean up group
      this.groups.delete(groupId);
      return { shouldDisposeAgent: true };
    }

    // Group still has windows — agent survives
    let newRoot: string | undefined;
    if (group.root === windowId) {
      // Root closed — promote the lexicographically first surviving window (deterministic)
      newRoot = [...group.windows].sort()[0];
      group.root = newRoot;
    }

    return { shouldDisposeAgent: false, newRoot };
  }

  /**
   * Reset all state.
   */
  clear(): void {
    this.windowToGroup.clear();
    this.groups.clear();
  }
}
