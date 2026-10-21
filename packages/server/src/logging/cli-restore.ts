/**
 * Reconstruct CLI history entries from session log messages.
 *
 * Reads ParsedMessages and produces CliRestoreEntry[] that the frontend
 * can load into its CLI history store on reconnection / server restart.
 */

import type { ParsedMessage } from './types.js';
import type { CliRestoreEntry } from '@yaar/shared';
import { monitorIdOfRole } from '../agents/roles.js';

const MAX_CLI_RESTORE_ENTRIES = 200;

/**
 * Convert session log messages into CLI restore entries.
 * Only includes monitor-scoped messages (not window agent messages).
 */
export function getCliRestoreEntries(messages: ParsedMessage[]): CliRestoreEntry[] {
  const entries: CliRestoreEntry[] = [];

  for (const msg of messages) {
    const monitorId = monitorIdOfRole(msg.agentId);
    if (monitorId === null) continue; // Skip window/app agent messages

    const timestamp = new Date(msg.timestamp).getTime();

    switch (msg.type) {
      case 'user':
        if (typeof msg.content === 'string') {
          entries.push({
            type: 'user',
            content: msg.content,
            agentId: msg.agentId ?? undefined,
            monitorId,
            timestamp,
          });
        }
        break;

      case 'assistant':
        if (typeof msg.content === 'string') {
          entries.push({
            type: 'response',
            content: msg.content,
            agentId: msg.agentId ?? undefined,
            monitorId,
            timestamp,
          });
        }
        break;

      case 'thinking':
        if (typeof msg.content === 'string') {
          entries.push({
            type: 'thinking',
            content: msg.content,
            agentId: msg.agentId ?? undefined,
            monitorId,
            timestamp,
          });
        }
        break;

      case 'tool_use':
        if (msg.toolName) {
          const inputStr =
            typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '');
          entries.push({
            type: 'tool',
            content: `[${msg.toolName}] ${inputStr}`,
            agentId: msg.agentId ?? undefined,
            monitorId,
            timestamp,
          });
        }
        break;

      case 'action':
        if (msg.action) {
          const a = msg.action;
          let summary: string;
          if (a.type === 'window.create')
            summary = `Created window: ${(a as { title?: string }).title ?? (a as { windowId?: string }).windowId}`;
          else if (a.type === 'window.close')
            summary = `Closed window: ${(a as { windowId?: string }).windowId}`;
          else if (a.type === 'window.setContent')
            summary = `Updated content: ${(a as { windowId?: string }).windowId}`;
          else summary = a.type;
          entries.push({
            type: 'action-summary',
            content: summary,
            agentId: msg.agentId ?? undefined,
            monitorId,
            timestamp,
          });
        }
        break;
    }
  }

  // Keep only the most recent entries per monitor
  const byMonitor = new Map<string, CliRestoreEntry[]>();
  for (const entry of entries) {
    let arr = byMonitor.get(entry.monitorId);
    if (!arr) {
      arr = [];
      byMonitor.set(entry.monitorId, arr);
    }
    arr.push(entry);
  }

  const result: CliRestoreEntry[] = [];
  for (const [, arr] of byMonitor) {
    const capped = arr.length > MAX_CLI_RESTORE_ENTRIES ? arr.slice(-MAX_CLI_RESTORE_ENTRIES) : arr;
    result.push(...capped);
  }

  return result;
}
