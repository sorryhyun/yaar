/**
 * Shared types and constants for agent profiles.
 * Separate file to avoid circular dependencies between index.ts and profile files.
 */

import { SYSTEM_TOOL_NAMES } from '../../mcp/system/tool-names.js';

export interface AgentProfile {
  id: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  model?: string;
}

// Inlined to avoid circular dependency: handlers/index → session-hub → live-session → context-pool → monitor-task-processor → profiles → handlers/index
export const VERB_TOOL_NAMES = [
  'mcp__verbs__describe',
  'mcp__verbs__read',
  'mcp__verbs__list',
  'mcp__verbs__invoke',
  'mcp__verbs__delete',
] as const;

export const VERB_TOOLS = ['WebSearch', ...SYSTEM_TOOL_NAMES, ...VERB_TOOL_NAMES] as const;

// Inlined (mirrors VERB_TOOL_NAMES above) to avoid a circular dependency with mcp/messaging.
export const MESSAGING_TOOL_NAMES = ['mcp__messaging__direct_message'] as const;

export const APP_AGENT_TOOL_NAMES = [
  'mcp__app__query',
  'mcp__app__command',
  'mcp__app__relay',
  'mcp__app__describe',
  ...MESSAGING_TOOL_NAMES,
] as const;
