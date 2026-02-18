/**
 * WebSocket event types for client-server communication.
 */

import type { OSAction, PermissionOptions } from './actions.js';
import type { AppProtocolRequest, AppProtocolResponse } from './app-protocol.js';

// ============ Event Type Constants ============

/** Server → Client event type discriminants. */
export const ServerEventType = {
  ACTIONS: 'ACTIONS',
  AGENT_THINKING: 'AGENT_THINKING',
  AGENT_RESPONSE: 'AGENT_RESPONSE',
  CONNECTION_STATUS: 'CONNECTION_STATUS',
  TOOL_PROGRESS: 'TOOL_PROGRESS',
  ERROR: 'ERROR',
  WINDOW_AGENT_STATUS: 'WINDOW_AGENT_STATUS',
  MESSAGE_ACCEPTED: 'MESSAGE_ACCEPTED',
  MESSAGE_QUEUED: 'MESSAGE_QUEUED',
  APPROVAL_REQUEST: 'APPROVAL_REQUEST',
  APP_PROTOCOL_REQUEST: 'APP_PROTOCOL_REQUEST',
} as const;

/** Client → Server event type discriminants. */
export const ClientEventType = {
  USER_MESSAGE: 'USER_MESSAGE',
  WINDOW_MESSAGE: 'WINDOW_MESSAGE',
  INTERRUPT: 'INTERRUPT',
  INTERRUPT_AGENT: 'INTERRUPT_AGENT',
  RESET: 'RESET',
  SET_PROVIDER: 'SET_PROVIDER',
  RENDERING_FEEDBACK: 'RENDERING_FEEDBACK',
  COMPONENT_ACTION: 'COMPONENT_ACTION',
  DIALOG_FEEDBACK: 'DIALOG_FEEDBACK',
  TOAST_ACTION: 'TOAST_ACTION',
  USER_PROMPT_RESPONSE: 'USER_PROMPT_RESPONSE',
  USER_INTERACTION: 'USER_INTERACTION',
  APP_PROTOCOL_RESPONSE: 'APP_PROTOCOL_RESPONSE',
  APP_PROTOCOL_READY: 'APP_PROTOCOL_READY',
  SUBSCRIBE_MONITOR: 'SUBSCRIBE_MONITOR',
  REMOVE_MONITOR: 'REMOVE_MONITOR',
} as const;

// ============ Client → Server Events ============

export interface UserInteraction {
  type:
    | 'window.close'
    | 'window.focus'
    | 'window.move'
    | 'window.resize'
    | 'window.minimize'
    | 'window.maximize'
    | 'toast.dismiss'
    | 'notification.dismiss'
    | 'icon.click'
    | 'icon.drag'
    | 'selection.action'
    | 'region.select'
    | 'draw';
  timestamp: number;
  windowId?: string;
  windowTitle?: string;
  details?: string;
  instruction?: string; // User instruction for selection.action and region.select
  selectedText?: string; // Selected text for selection.action
  region?: { x: number; y: number; w: number; h: number }; // Region bounds for region.select
  contentHint?: string; // Extracted text within region for region.select
  sourceAppId?: string; // App ID for icon.drag
  imageData?: string; // Base64 PNG for drawings
  bounds?: { x: number; y: number; w: number; h: number };
}

/**
 * Format a UserInteraction into a compact ID-only string for the AI timeline.
 * e.g. "close:win-settings", "focus:win-main", "move:win-main {x:10,y:20,w:600,h:400}"
 */
export function formatCompactInteraction(interaction: UserInteraction): string {
  const verb = interaction.type.split('.')[1]; // 'close', 'focus', 'move', etc.
  const target = interaction.windowId ?? interaction.details ?? '';
  let result = target ? `${verb}:${target}` : verb;
  if (interaction.bounds) {
    const b = interaction.bounds;
    result += ` {x:${b.x},y:${b.y},w:${b.w},h:${b.h}}`;
  }
  if (interaction.instruction) {
    result += ` "${interaction.instruction}"`;
  }
  return result;
}

export interface UserMessageEvent {
  type: typeof ClientEventType.USER_MESSAGE;
  messageId: string;
  content: string;
  interactions?: UserInteraction[];
  monitorId?: string;
}

export interface WindowMessageEvent {
  type: typeof ClientEventType.WINDOW_MESSAGE;
  messageId: string;
  windowId: string;
  content: string;
}

export interface InterruptEvent {
  type: typeof ClientEventType.INTERRUPT;
}

export interface InterruptAgentEvent {
  type: typeof ClientEventType.INTERRUPT_AGENT;
  agentId: string;
}

export interface ResetEvent {
  type: typeof ClientEventType.RESET;
}

export interface SetProviderEvent {
  type: typeof ClientEventType.SET_PROVIDER;
  provider: 'claude' | 'codex';
}

export interface RenderingFeedbackEvent {
  type: typeof ClientEventType.RENDERING_FEEDBACK;
  requestId: string;
  windowId: string;
  renderer: string;
  success: boolean;
  error?: string;
  url?: string;
  locked?: boolean;
  imageData?: string;
}

export interface ComponentActionEvent {
  type: typeof ClientEventType.COMPONENT_ACTION;
  windowId: string;
  windowTitle?: string; // Title of the window containing the component
  action: string;
  actionId?: string; // Unique ID for parallel execution (generated for parallel buttons)
  formData?: Record<string, string | number | boolean>; // Form field values when submitForm is used
  formId?: string; // Form ID when submitForm is used
  componentPath?: string[]; // Path through component tree (e.g., ["Card:Settings", "Form:config", "Button:Save"])
}

export interface DialogFeedbackEvent {
  type: typeof ClientEventType.DIALOG_FEEDBACK;
  dialogId: string;
  confirmed: boolean;
  rememberChoice?: 'once' | 'always' | 'deny_always';
}

export interface ToastActionEvent {
  type: typeof ClientEventType.TOAST_ACTION;
  toastId: string;
  eventId: string;
}

export interface UserPromptResponseEvent {
  type: typeof ClientEventType.USER_PROMPT_RESPONSE;
  promptId: string;
  selectedValues?: string[];
  text?: string;
  dismissed?: boolean;
}

export interface UserInteractionEvent {
  type: typeof ClientEventType.USER_INTERACTION;
  interactions: UserInteraction[];
}

export interface AppProtocolResponseEvent {
  type: typeof ClientEventType.APP_PROTOCOL_RESPONSE;
  requestId: string;
  windowId: string;
  response: AppProtocolResponse;
}

export interface AppProtocolReadyEvent {
  type: typeof ClientEventType.APP_PROTOCOL_READY;
  windowId: string;
}

export interface SubscribeMonitorEvent {
  type: typeof ClientEventType.SUBSCRIBE_MONITOR;
  monitorId: string;
}

export interface RemoveMonitorEvent {
  type: typeof ClientEventType.REMOVE_MONITOR;
  monitorId: string;
}

export type ClientEvent =
  | UserMessageEvent
  | WindowMessageEvent
  | InterruptEvent
  | InterruptAgentEvent
  | ResetEvent
  | SetProviderEvent
  | RenderingFeedbackEvent
  | ComponentActionEvent
  | DialogFeedbackEvent
  | ToastActionEvent
  | UserPromptResponseEvent
  | UserInteractionEvent
  | AppProtocolResponseEvent
  | AppProtocolReadyEvent
  | SubscribeMonitorEvent
  | RemoveMonitorEvent;

// ============ Server → Client Events ============

export interface ActionsEvent {
  type: typeof ServerEventType.ACTIONS;
  actions: OSAction[];
  agentId?: string;
  monitorId?: string;
}

export interface AgentThinkingEvent {
  type: typeof ServerEventType.AGENT_THINKING;
  content: string;
  agentId?: string;
  monitorId?: string;
}

export interface AgentResponseEvent {
  type: typeof ServerEventType.AGENT_RESPONSE;
  content: string;
  isComplete: boolean;
  agentId?: string;
  monitorId?: string;
  messageId?: string;
}

export interface ConnectionStatusEvent {
  type: typeof ServerEventType.CONNECTION_STATUS;
  status: 'connected' | 'disconnected' | 'error';
  provider?: string;
  sessionId?: string;
  error?: string;
}

export interface ToolProgressEvent {
  type: typeof ServerEventType.TOOL_PROGRESS;
  toolName: string;
  status: 'running' | 'complete' | 'error';
  message?: string;
  toolInput?: unknown;
  agentId?: string;
  monitorId?: string;
}

export interface ErrorEvent {
  type: typeof ServerEventType.ERROR;
  error: string;
  agentId?: string;
  monitorId?: string;
}

export interface WindowAgentStatusEvent {
  type: typeof ServerEventType.WINDOW_AGENT_STATUS;
  windowId: string;
  agentId: string;
  status: 'assigned' | 'active' | 'released';
}

export interface MessageAcceptedEvent {
  type: typeof ServerEventType.MESSAGE_ACCEPTED;
  messageId: string;
  agentId: string;
}

export interface MessageQueuedEvent {
  type: typeof ServerEventType.MESSAGE_QUEUED;
  messageId: string;
  position: number;
}

export interface ApprovalRequestEvent {
  type: typeof ServerEventType.APPROVAL_REQUEST;
  dialogId: string;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  permissionOptions?: PermissionOptions;
  agentId?: string;
}

export interface AppProtocolRequestEvent {
  type: typeof ServerEventType.APP_PROTOCOL_REQUEST;
  requestId: string;
  windowId: string;
  request: AppProtocolRequest;
}

export type ServerEvent =
  | ActionsEvent
  | AgentThinkingEvent
  | AgentResponseEvent
  | ConnectionStatusEvent
  | ToolProgressEvent
  | ErrorEvent
  | WindowAgentStatusEvent
  | MessageAcceptedEvent
  | MessageQueuedEvent
  | ApprovalRequestEvent
  | AppProtocolRequestEvent;
