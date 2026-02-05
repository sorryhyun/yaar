import { computeFingerprint } from '../../reload/index.js';
import type { ReloadCache } from '../../reload/cache.js';
import type { CacheMatch, Fingerprint } from '../../reload/types.js';
import type { WindowState, OSAction } from '@yaar/shared';
import type { Task } from '../context-pool.js';

export class ReloadCachePolicy {
  constructor(private readonly cache: ReloadCache) {}

  buildFingerprint(task: Task, windowSnapshot: WindowState[]): Fingerprint {
    return computeFingerprint(task, windowSnapshot);
  }

  findMatches(fingerprint: Fingerprint, limit = 3): CacheMatch[] {
    return this.cache.findMatches(fingerprint, limit);
  }

  formatReloadOptions(matches: CacheMatch[]): string {
    if (matches.length === 0) return '';

    const options = matches.map(m => ({
      cacheId: m.entry.id,
      label: m.entry.label,
      similarity: parseFloat(m.similarity.toFixed(2)),
      actions: m.entry.actions.length,
      exact: m.isExact,
    }));

    return `<reload_options>\n${JSON.stringify(options)}\n</reload_options>\n\n`;
  }

  maybeRecord(task: Task, fingerprint: Fingerprint, actions: OSAction[], windowId?: string): void {
    if (actions.length === 0) return;

    const requiredWindowIds = windowId ? [windowId] : undefined;
    this.cache.record(fingerprint, actions, this.generateCacheLabel(task), { requiredWindowIds });
  }

  generateCacheLabel(task: Task): string {
    const content = task.content.trim();

    const appMatch = content.match(/app:\s*(\w+)/i);
    if (appMatch) return `Open ${appMatch[1]} app`;

    const buttonMatch = content.match(/button\s+"([^"]+)"/i);
    if (buttonMatch) return `Click "${buttonMatch[1]}"`;

    const maxLen = 50;
    if (content.length <= maxLen) return content;
    return content.slice(0, maxLen).trimEnd() + '...';
  }
}
