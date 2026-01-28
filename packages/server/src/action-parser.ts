/**
 * Action parser - extracts OS Actions from AI response text.
 *
 * Supports two formats:
 * 1. Tool calls: <tool:showWindow>{"windowId": "...", ...}</tool:showWindow>
 * 2. Legacy JSON blocks (backwards compat)
 */

import type { OSAction, WindowContent, WindowBounds } from '@claudeos/shared';

/**
 * Pattern to find tool calls in response text.
 *
 * Matches:
 * <tool:showWindow>{"windowId": "w1", "title": "Hello", ...}</tool:showWindow>
 * <tool:showMessage>{"message": "Done!", "variant": "success"}</tool:showMessage>
 * <tool:closeWindow>{"windowId": "w1"}</tool:closeWindow>
 */
const TOOL_CALL_PATTERN =
  /<tool:(showWindow|showMessage|closeWindow)>([\s\S]*?)<\/tool:\1>/g;

/**
 * Legacy pattern for JSON code blocks (backwards compat).
 */
const LEGACY_ACTION_PATTERN =
  /```(?:json)?\s*\n(\{[^`]*"type"\s*:\s*"(?:window|notification|toast)[^`]*\})\s*\n```/gm;

/**
 * Input types for tools.
 */
interface ShowWindowInput {
  windowId: string;
  title: string;
  content: string;
  renderer?: 'markdown' | 'text' | 'html';
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface ShowMessageInput {
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
}

interface CloseWindowInput {
  windowId: string;
}

/**
 * Convert a tool call to an OS Action.
 */
function toolToAction(toolName: string, input: unknown): OSAction | null {
  switch (toolName) {
    case 'showWindow': {
      const params = input as ShowWindowInput;
      if (!params.windowId || !params.title || params.content === undefined) {
        return null;
      }
      const bounds: WindowBounds = {
        x: params.x ?? 100,
        y: params.y ?? 100,
        w: params.width ?? 500,
        h: params.height ?? 400,
      };
      const content: WindowContent = {
        renderer: params.renderer ?? 'markdown',
        data: params.content,
      };
      return {
        type: 'window.create',
        windowId: params.windowId,
        title: params.title,
        bounds,
        content,
      };
    }

    case 'showMessage': {
      const params = input as ShowMessageInput;
      if (!params.message) {
        return null;
      }
      return {
        type: 'toast.show',
        id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        message: params.message,
        variant: params.variant ?? 'info',
      };
    }

    case 'closeWindow': {
      const params = input as CloseWindowInput;
      if (!params.windowId) {
        return null;
      }
      return {
        type: 'window.close',
        windowId: params.windowId,
      };
    }

    default:
      return null;
  }
}

/**
 * Extract OS Actions from tool calls in response text.
 */
function extractToolCalls(text: string): OSAction[] {
  const actions: OSAction[] = [];

  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_PATTERN.exec(text)) !== null) {
    const toolName = match[1];
    const jsonContent = match[2].trim();

    try {
      const input = JSON.parse(jsonContent);
      const action = toolToAction(toolName, input);
      if (action) {
        actions.push(action);
      }
    } catch {
      // Skip invalid JSON
      continue;
    }
  }

  TOOL_CALL_PATTERN.lastIndex = 0;
  return actions;
}

/**
 * Extract OS Actions from legacy JSON code blocks.
 */
function extractLegacyActions(text: string): OSAction[] {
  const actions: OSAction[] = [];

  let match: RegExpExecArray | null;
  while ((match = LEGACY_ACTION_PATTERN.exec(text)) !== null) {
    try {
      const action = JSON.parse(match[1]) as Record<string, unknown>;

      if (typeof action === 'object' && action !== null && 'type' in action) {
        const actionType = String(action.type);

        if (
          actionType.startsWith('window.') ||
          actionType.startsWith('notification.') ||
          actionType.startsWith('toast.')
        ) {
          actions.push(action as unknown as OSAction);
        }
      }
    } catch {
      continue;
    }
  }

  LEGACY_ACTION_PATTERN.lastIndex = 0;
  return actions;
}

/**
 * Extract OS Actions from response text.
 * Supports both tool call format and legacy JSON blocks.
 */
export function extractActions(text: string): OSAction[] {
  // Try tool calls first (preferred format)
  const toolActions = extractToolCalls(text);
  if (toolActions.length > 0) {
    return toolActions;
  }

  // Fall back to legacy JSON blocks
  return extractLegacyActions(text);
}

/**
 * Information about detected tool calls for UI feedback.
 */
export interface DetectedToolCall {
  name: string;
  input: unknown;
}

/**
 * Extract tool call metadata for progress display.
 */
export function extractToolCallInfo(text: string): DetectedToolCall[] {
  const tools: DetectedToolCall[] = [];

  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_PATTERN.exec(text)) !== null) {
    const toolName = match[1];
    const jsonContent = match[2].trim();

    try {
      const input = JSON.parse(jsonContent);
      tools.push({ name: toolName, input });
    } catch {
      continue;
    }
  }

  TOOL_CALL_PATTERN.lastIndex = 0;
  return tools;
}
