/**
 * Window and UI tools for ClaudeOS.
 *
 * Provides tools for:
 * - Creating and managing windows
 * - Updating window content with diff-based operations
 * - Toast notifications
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { WINDOW_PRESETS, type WindowPreset, type OSAction, type ContentUpdateOperation } from '@claudeos/shared';
import { actionEmitter } from './action-emitter.js';

/** Helper to create MCP tool result */
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });

/**
 * Create a window on the ClaudeOS desktop.
 */
export const createWindow = tool(
  'create_window',
  'Create a new window on the ClaudeOS desktop. Use presets for consistent styling. Content is optional and defaults to empty.',
  {
    windowId: z.string().describe('Unique identifier for the window'),
    title: z.string().describe('Window title'),
    content: z.string().optional().describe('Initial content to display in the window. Defaults to empty string'),
    preset: z.enum(['default', 'info', 'alert', 'document', 'sidebar', 'dialog']).optional().describe('Window preset for consistent styling. Defaults to "default"'),
    renderer: z.enum(['markdown', 'text', 'html']).optional().describe('Content renderer. Defaults to "markdown"'),
    x: z.number().optional().describe('X position (overrides preset)'),
    y: z.number().optional().describe('Y position (overrides preset)'),
    width: z.number().optional().describe('Width (overrides preset)'),
    height: z.number().optional().describe('Height (overrides preset)')
  },
  async (args) => {
    const presetName = (args.preset || 'default') as WindowPreset;
    const preset = WINDOW_PRESETS[presetName];

    const osAction: OSAction = {
      type: 'window.create',
      windowId: args.windowId,
      title: args.title,
      bounds: {
        x: args.x ?? preset.x ?? 100,
        y: args.y ?? preset.y ?? 100,
        w: args.width ?? preset.width,
        h: args.height ?? preset.height
      },
      content: {
        renderer: args.renderer || 'markdown',
        data: args.content ?? ''
      }
    };

    // Emit action directly to frontend
    actionEmitter.emitAction(osAction);

    return ok(`Created window "${args.windowId}"`);

  }
);

/**
 * Update window content with diff-based operations.
 */
export const updateWindow = tool(
  'update_window',
  'Update the content of an existing window using diff-based operations: append, prepend, replace, insertAt, or clear.',
  {
    windowId: z.string().describe('ID of the window to update'),
    operation: z.enum(['append', 'prepend', 'replace', 'insertAt', 'clear']).describe('The operation to perform on the content'),
    content: z.string().optional().describe('Content for the operation (not needed for clear)'),
    position: z.number().optional().describe('Character position for insertAt operation')
  },
  async (args) => {
    // Build the operation based on the operation type
    let operation: ContentUpdateOperation;

    switch (args.operation) {
      case 'append':
        operation = { op: 'append', data: args.content ?? '' };
        break;
      case 'prepend':
        operation = { op: 'prepend', data: args.content ?? '' };
        break;
      case 'replace':
        operation = { op: 'replace', data: args.content ?? '' };
        break;
      case 'insertAt':
        if (args.position === undefined) {
          return ok('Error: position is required for insertAt operation');
        }
        operation = { op: 'insertAt', position: args.position, data: args.content ?? '' };
        break;
      case 'clear':
        operation = { op: 'clear' };
        break;
    }

    const osAction = {
      type: 'window.updateContent' as const,
      windowId: args.windowId,
      operation
    };

    // Emit action directly to frontend
    actionEmitter.emitAction(osAction);

    return ok(`Updated window "${args.windowId}" (${args.operation})`);

  }
);

/**
 * Close a window on the ClaudeOS desktop.
 */
export const closeWindow = tool(
  'close_window',
  'Close a window on the ClaudeOS desktop',
  {
    windowId: z.string().describe('ID of the window to close')
  },
  async (args) => {
    const osAction: OSAction = {
      type: 'window.close',
      windowId: args.windowId
    };

    // Emit action directly to frontend
    actionEmitter.emitAction(osAction);

    return ok(`Closed window "${args.windowId}"`);

  }
);

/**
 * Show a toast notification on the ClaudeOS desktop.
 */
export const showToast = tool(
  'show_toast',
  'Display a toast notification on the ClaudeOS desktop',
  {
    id: z.string().optional().describe('Optional unique identifier for the toast. Auto-generated if not provided'),
    message: z.string().describe('Toast message to display'),
    variant: z.enum(['info', 'success', 'warning', 'error']).optional().describe('Toast variant. Defaults to "info"')
  },
  async (args) => {
    const osAction: OSAction = {
      type: 'toast.show',
      id: args.id || `toast-${Date.now()}`,
      message: args.message,
      variant: args.variant || 'info'
    };

    // Emit action directly to frontend
    actionEmitter.emitAction(osAction);

    return ok('Toast displayed');

  }
);

/**
 * Lock a window to prevent other agents from modifying it.
 */
export const lockWindow = tool(
  'lock_window',
  'Lock a window to prevent other agents from modifying its content. Only the locking agent can modify or unlock the window.',
  {
    windowId: z.string().describe('ID of the window to lock'),
    agentId: z.string().describe('Unique identifier for the agent acquiring the lock')
  },
  async (args) => {
    const osAction: OSAction = {
      type: 'window.lock',
      windowId: args.windowId,
      agentId: args.agentId
    };

    actionEmitter.emitAction(osAction);

    return ok(`Locked window "${args.windowId}"`);

  }
);

/**
 * Unlock a window to allow other agents to modify it.
 */
export const unlockWindow = tool(
  'unlock_window',
  'Unlock a previously locked window. Only the agent that locked the window can unlock it.',
  {
    windowId: z.string().describe('ID of the window to unlock'),
    agentId: z.string().describe('Unique identifier for the agent releasing the lock (must match the locking agent)')
  },
  async (args) => {
    const osAction: OSAction = {
      type: 'window.unlock',
      windowId: args.windowId,
      agentId: args.agentId
    };

    actionEmitter.emitAction(osAction);

    return ok(`Unlocked window "${args.windowId}"`);

  }
);

/**
 * All window/UI tools.
 */
export const windowTools = [
  createWindow,
  updateWindow,
  closeWindow,
  showToast,
  lockWindow,
  unlockWindow
];
