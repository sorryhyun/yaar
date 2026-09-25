/**
 * Display strings for `TOOL_PROGRESS` events: the status-bar line and the CLI entry a
 * tool call produces. Pure, so the dispatcher's case only decides *which* handlers run.
 */
import { SUBAGENT_TOOL_NAME } from '@/types';

/** Subagent lifecycle and progress tools (exact match for start/end, prefix for progress). */
export function isSubagentTool(toolName: string): boolean {
  return toolName === SUBAGENT_TOOL_NAME || toolName.startsWith(`${SUBAGENT_TOOL_NAME}:`);
}

/** Agent/Task tool_use: the raw invocation from Claude, carrying the full prompt. */
export function isAgentTool(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task';
}

/** The name a CLI entry is filed under: `subagent:read` → `subagent → read`. */
export function toolDisplayName(toolName: string): string {
  if (isSubagentTool(toolName)) return toolName.replace(':', ' → ');
  if (isAgentTool(toolName)) return 'subagent';
  return toolName;
}

export function runningStatusText(toolName: string, toolInput: unknown): string {
  const isSubagent = isSubagentTool(toolName);
  const isAgent = isAgentTool(toolName);
  if (!(isSubagent || isAgent) || !toolInput) return `Running: ${toolName}`;

  const input = toolInput as Record<string, unknown>;
  const agentType = (input.subagent_type ?? '') as string;
  const desc = (input.description ?? input.prompt ?? '') as string;
  const shortDesc = desc ? (desc.length > 60 ? desc.slice(0, 60) + '...' : desc) : '';
  if (isAgent && agentType) {
    return `Subagent (${agentType})${shortDesc ? ': ' + shortDesc : ''}`;
  }
  if (toolName.startsWith(`${SUBAGENT_TOOL_NAME}:`)) {
    const innerTool = toolName.replace(`${SUBAGENT_TOOL_NAME}:`, '');
    // Prefer URI over description for status text
    const uri = (input.uri ?? '') as string;
    const detail = uri || shortDesc;
    return `Subagent → ${innerTool}${detail ? ': ' + detail : ''}`;
  }
  if (shortDesc) return `Subagent: ${shortDesc}`;
  return `Running: ${toolName}`;
}

export function errorStatusText(toolName: string, errorMsg: string | undefined): string {
  return `Error: ${toolName}${errorMsg ? ' — ' + errorMsg.slice(0, 80) : ''}`;
}

/** The summarized input a `running` call is filed under in CLI history. */
export function toolInputSummary(toolName: string, toolInput: unknown): string {
  let inputStr: string;
  if (isAgentTool(toolName)) {
    // Agent tool_use: show subagent type + prompt from monitor agent
    const input = toolInput as Record<string, unknown>;
    const agentType = (input.subagent_type ?? '') as string;
    const prompt = (input.prompt ?? input.description ?? '') as string;
    inputStr = agentType ? `(${agentType}) ${prompt}` : prompt;
    if (!inputStr) inputStr = JSON.stringify(toolInput);
  } else if (isSubagentTool(toolName)) {
    // Subagent tool progress: prefer URI (enriched by server) over description
    const input = toolInput as Record<string, unknown>;
    if (input.uri) {
      // Rich info from MCP buffer: show verb:(uri) format
      const payload = input.payload as Record<string, unknown> | undefined;
      const action = payload?.action;
      inputStr = action ? `${input.uri} (${action})` : (input.uri as string);
    } else {
      inputStr = (input.description ?? input.prompt ?? '') as string;
    }
    if (!inputStr) inputStr = JSON.stringify(toolInput);
  } else {
    inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
  }
  return inputStr;
}

/**
 * The CLI history entry for a call that reached `running` or `error`: its input when a
 * running call carried one, its status word otherwise.
 */
export function toolEntryContent(toolName: string, status: string, toolInput: unknown): string {
  const displayName = toolDisplayName(toolName);
  if (status === 'running' && toolInput) {
    return `[${displayName}] ${toolInputSummary(toolName, toolInput)}`;
  }
  return `[${displayName}] ${status}`;
}
