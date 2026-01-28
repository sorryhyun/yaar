/**
 * Window and UI tools for ClaudeOS.
 *
 * Provides tools for:
 * - Creating and managing windows
 * - Toast notifications
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { WINDOW_PRESETS, type WindowPreset, type OSAction } from '@claudeos/shared';
import { actionEmitter } from './action-emitter.js';

/**
 * Show a window on the ClaudeOS desktop.
 */
export const showWindow = tool(
  'show_window',
  'Display content in a window on the ClaudeOS desktop. Use presets for consistent styling.',
  {
    windowId: z.string().describe('Unique identifier for the window'),
    title: z.string().describe('Window title'),
    content: z.string().describe('Content to display in the window'),
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
        data: args.content
      }
    };

    // Emit action directly to frontend
    actionEmitter.emitAction(osAction);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ osAction, success: true, message: `Window "${args.title}" created` })
      }]
    };
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

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ osAction, success: true, message: `Window "${args.windowId}" closed` })
      }]
    };
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

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ osAction, success: true, message: 'Toast displayed' })
      }]
    };
  }
);

/**
 * All window/UI tools.
 */
export const windowTools = [
  showWindow,
  closeWindow,
  showToast
];
