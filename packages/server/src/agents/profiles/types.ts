/**
 * Shared types and constants for agent profiles.
 * Separate file to avoid circular dependencies between index.ts and profile files.
 */

import { SYSTEM_TOOL_NAMES } from '../../mcp/system/index.js';

export interface AgentProfile {
  id: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
}

// Inlined to avoid circular dependency: handlers/index → session-hub → live-session → context-pool → main-task-processor → profiles → handlers/index
export const VERB_TOOL_NAMES = [
  'mcp__verbs__describe',
  'mcp__verbs__read',
  'mcp__verbs__list',
  'mcp__verbs__invoke',
  'mcp__verbs__delete',
] as const;

export const VERB_TOOLS = ['WebSearch', ...SYSTEM_TOOL_NAMES, ...VERB_TOOL_NAMES] as const;
