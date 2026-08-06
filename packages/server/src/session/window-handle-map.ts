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
  /**
   * rawWindowId → monitorId → handle (for O(1) lookup by AI-facing ID).
   *
   * Nested by monitor because a raw ID is only unique *within* a monitor: window
   * IDs are derived from the appId (`deriveWindowId`), so the same app open on two
   * monitors has the same raw ID on both. A flat rawId → handle index would let
   * whichever monitor registered last own the ID session-wide, and the other
   * monitor's lookups would silently resolve into its windows.
   */
  private rawToHandles = new Map<string, Map<string, string>>();

  /**
   * Register a new window and return its handle.
   * If no monitorId is provided, the rawId is used as-is (legacy/restore path).
   */
  register(rawWindowId: string, monitorId?: string): string {
    const handle = monitorId ? `${monitorId}/${rawWindowId}` : rawWindowId;
    if (monitorId) {
      this.handleToMonitor.set(handle, monitorId);
      let byMonitor = this.rawToHandles.get(rawWindowId);
      if (!byMonitor) {
        byMonitor = new Map();
        this.rawToHandles.set(rawWindowId, byMonitor);
      }
      byMonitor.set(monitorId, handle);
    }
    return handle;
  }

  /**
   * The handle a raw ID *would* have on a monitor, without registering anything.
   *
   * `register` is for a window that exists. This is for the moment before one does:
   * `window.create` records the grants it is handing the new window *before* the emit,
   * and a grant filed under the bare raw ID is one that every monitor's copy of the same
   * app can read. Returns the ID unchanged when there is no monitor to scope it to, or
   * when it is already a handle — scoping a handle again mints "0/1/memo", a key nothing
   * else ever produces.
   */
  handleFor(rawWindowId: string, monitorId?: string): string {
    if (!monitorId) return rawWindowId;
    if (this.handleToMonitor.has(rawWindowId) || rawWindowId.includes('/')) return rawWindowId;
    return `${monitorId}/${rawWindowId}`;
  }

  /**
   * Remove a handle and its index entries. Only the owning monitor's entry is
   * dropped — another monitor's window with the same raw ID keeps its mapping.
   */
  remove(handle: string): void {
    const monitorId = this.handleToMonitor.get(handle);
    this.handleToMonitor.delete(handle);
    const raw = this.extractRawId(handle);
    if (raw === handle) return;
    const byMonitor = this.rawToHandles.get(raw);
    if (!byMonitor) return;
    if (monitorId !== undefined) byMonitor.delete(monitorId);
    if (byMonitor.size === 0) this.rawToHandles.delete(raw);
  }

  /**
   * Resolve a windowId (raw or handle) to its handle.
   *
   * Pass the caller's `monitorId` whenever it is known: a raw ID names a window
   * only within one monitor, so an unscoped lookup cannot tell two monitors'
   * copies of the same app apart. With a monitorId, only that monitor's window
   * can match — never another's. Without one, an unambiguous raw ID (open on
   * exactly one monitor) still resolves; an ambiguous one returns undefined
   * rather than guessing a monitor.
   */
  resolve(windowId: string, monitorId?: string): string | undefined {
    // Already a known handle?
    if (this.handleToMonitor.has(windowId)) return windowId;

    const byMonitor = this.rawToHandles.get(windowId);
    if (!byMonitor) return undefined;
    if (monitorId !== undefined) return byMonitor.get(monitorId);
    if (byMonitor.size === 1) return byMonitor.values().next().value;
    return undefined;
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
   * Check if a handle (or raw ID) is registered. Scoped to a monitor when one is
   * given, so a raw ID open only on another monitor does not count as present.
   */
  has(windowId: string, monitorId?: string): boolean {
    if (this.handleToMonitor.has(windowId)) return true;
    return this.resolve(windowId, monitorId) !== undefined;
  }

  clear(): void {
    this.handleToMonitor.clear();
    this.rawToHandles.clear();
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
