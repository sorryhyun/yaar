/**
 * WebSocket event types for client-server communication.
 */

import type { OSAction, PermissionOptions } from './actions.js';

// ============ Client → Server Events ============

export interface UserInteraction {
  type: 'window.close' | 'window.focus' | 'window.move' | 'window.resize' | 'window.minimize' | 'window.maximize' | 'toast.dismiss' | 'notification.dismiss' | 'icon.click' | 'draw';
  timestamp: number;
  windowId?: string;
  windowTitle?: string;
  details?: string;
  imageData?: string;  // Base64 PNG for drawings
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
  return result;
}

export interface UserMessageEvent {
  type: 'USER_MESSAGE';
  messageId: string;
  content: string;
  interactions?: UserInteraction[];
  monitorId?: string;
}

export interface WindowMessageEvent {
  type: 'WINDOW_MESSAGE';
  messageId: string;
  windowId: string;
  content: string;
}

export interface InterruptEvent {
  type: 'INTERRUPT';
}

export interface InterruptAgentEvent {
  type: 'INTERRUPT_AGENT';
  agentId: string;
}

export interface ResetEvent {
  type: 'RESET';
}

export interface SetProviderEvent {
  type: 'SET_PROVIDER';
  provider: 'claude' | 'codex';
}

export interface RenderingFeedbackEvent {
  type: 'RENDERING_FEEDBACK';
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
  type: 'COMPONENT_ACTION';
  windowId: string;
  windowTitle?: string; // Title of the window containing the component
  action: string;
  actionId?: string; // Unique ID for parallel execution (generated for parallel buttons)
  formData?: Record<string, string | number | boolean>; // Form field values when submitForm is used
  formId?: string; // Form ID when submitForm is used
  componentPath?: string[]; // Path through component tree (e.g., ["Card:Settings", "Form:config", "Button:Save"])
}

export interface DialogFeedbackEvent {
  type: 'DIALOG_FEEDBACK';
  dialogId: string;
  confirmed: boolean;
  rememberChoice?: 'once' | 'always' | 'deny_always';
}

export interface ToastActionEvent {
  type: 'TOAST_ACTION';
  toastId: string;
  eventId: string;
}

export interface UserInteractionEvent {
  type: 'USER_INTERACTION';
  interactions: UserInteraction[];
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
  | UserInteractionEvent;

// ============ Server → Client Events ============

export interface ActionsEvent {
  type: 'ACTIONS';
  actions: OSAction[];
  agentId?: string;
  monitorId?: string;
  seq?: number;
}

export interface AgentThinkingEvent {
  type: 'AGENT_THINKING';
  content: string;
  agentId?: string;
  monitorId?: string;
  seq?: number;
}

export interface AgentResponseEvent {
  type: 'AGENT_RESPONSE';
  content: string;
  isComplete: boolean;
  agentId?: string;
  monitorId?: string;
  messageId?: string;
  seq?: number;
}

export interface ConnectionStatusEvent {
  type: 'CONNECTION_STATUS';
  status: 'connected' | 'disconnected' | 'error';
  provider?: string;
  sessionId?: string;
  error?: string;
  seq?: number;
}

export interface ToolProgressEvent {
  type: 'TOOL_PROGRESS';
  toolName: string;
  status: 'running' | 'complete' | 'error';
  message?: string;
  agentId?: string;
  monitorId?: string;
  seq?: number;
}

export interface ErrorEvent {
  type: 'ERROR';
  error: string;
  agentId?: string;
  monitorId?: string;
  seq?: number;
}

export interface WindowAgentStatusEvent {
  type: 'WINDOW_AGENT_STATUS';
  windowId: string;
  agentId: string;
  status: 'assigned' | 'active' | 'released';
  seq?: number;
}

export interface MessageAcceptedEvent {
  type: 'MESSAGE_ACCEPTED';
  messageId: string;
  agentId: string;
  seq?: number;
}

export interface MessageQueuedEvent {
  type: 'MESSAGE_QUEUED';
  messageId: string;
  position: number;
  seq?: number;
}

export interface ApprovalRequestEvent {
  type: 'APPROVAL_REQUEST';
  dialogId: string;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  permissionOptions?: PermissionOptions;
  agentId?: string;
  seq?: number;
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
  | ApprovalRequestEvent;
