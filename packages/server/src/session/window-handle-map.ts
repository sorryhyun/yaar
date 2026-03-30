/**
 * WindowHandleMap — bidirectional mapping between raw window IDs and scoped handles.
 *
 * A "handle" is a globally-unique identifier for a window within a session,
 * currently encoded as "monitorId/rawWindowId" (e.g., "0/win-storage").
 * This class is the ONLY place that knows how to construct and parse that format.
 *
 * All other code should treat handles as opaque strings and use this map
 * to query monitor ownership or raw IDs when needed.
 */

export class WindowHandleMap {
  /** handle → monitorId */
  private handleToMonitor = new Map<string, string>();
  /** rawWindowId → handle (for O(1) lookup by AI-facing ID) */
  private rawToHandle = new Map<string, string>();

  /**
   * Register a new window and return its handle.
   * If no monitorId is provided, the rawId is used as-is (legacy/restore path).
   */
  register(rawWindowId: string, monitorId?: string): string {
    const handle = monitorId ? `${monitorId}/${rawWindowId}` : rawWindowId;
    if (monitorId) {
      this.handleToMonitor.set(handle, monitorId);
      this.rawToHandle.set(rawWindowId, handle);
    }
    return handle;
  }

  /**
   * Remove a handle and its index entries.
   */
  remove(handle: string): void {
    this.handleToMonitor.delete(handle);
    const raw = this.extractRawId(handle);
    if (raw !== handle) {
      this.rawToHandle.delete(raw);
    }
  }

  /**
   * Resolve a windowId (raw or handle) to its handle.
   * Returns undefined if not found.
   */
  resolve(windowId: string): string | undefined {
    // Already a known handle?
    if (this.handleToMonitor.has(windowId)) return windowId;
    // Raw ID lookup
    return this.rawToHandle.get(windowId);
  }

  /**
   * Get the monitorId that owns this handle.
   */
  getMonitorId(handle: string): string | undefined {
    return this.handleToMonitor.get(handle);
  }

  /**
   * Extract the raw (AI-facing) window ID from a handle.
   */
  getRawWindowId(handle: string): string {
    return this.extractRawId(handle);
  }

  /**
   * List all handles belonging to a specific monitor.
   */
  listByMonitor(monitorId: string): string[] {
    const result: string[] = [];
    for (const [handle, mid] of this.handleToMonitor) {
      if (mid === monitorId) result.push(handle);
    }
    return result;
  }

  /**
   * Check if a handle (or raw ID) is registered.
   */
  has(windowId: string): boolean {
    return this.handleToMonitor.has(windowId) || this.rawToHandle.has(windowId);
  }

  clear(): void {
    this.handleToMonitor.clear();
    this.rawToHandle.clear();
  }

  /**
   * Register a scoped handle (e.g., "0/dock") by parsing it into rawId + monitorId.
   * No-op if the handle has no slash (already raw). Returns the handle.
   */
  registerHandle(handle: string): string {
    const slashIdx = handle.indexOf('/');
    if (slashIdx >= 0) {
      const monitorId = handle.slice(0, slashIdx);
      const rawId = handle.slice(slashIdx + 1);
      return this.register(rawId, monitorId);
    }
    return handle;
  }

  // ── Internal ──

  private extractRawId(handle: string): string {
    const slashIdx = handle.indexOf('/');
    return slashIdx >= 0 ? handle.slice(slashIdx + 1) : handle;
  }
}
