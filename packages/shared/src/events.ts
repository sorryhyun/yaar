/**
 * WebSocket event types for client-server communication.
 */

import type { OSAction } from './actions.js';

// ============ Client → Server Events ============

export interface UserInteraction {
  type: 'window.close' | 'window.focus' | 'window.move' | 'window.resize' | 'window.minimize' | 'window.maximize' | 'toast.dismiss' | 'notification.dismiss' | 'icon.click' | 'draw';
  timestamp: number;
  windowId?: string;
  windowTitle?: string;
  details?: string;
  imageData?: string;  // Base64 PNG for drawings
}

export interface UserMessageEvent {
  type: 'USER_MESSAGE';
  messageId: string;
  content: string;
  interactions?: UserInteraction[];
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

export type ClientEvent =
  | UserMessageEvent
  | WindowMessageEvent
  | InterruptEvent
  | InterruptAgentEvent
  | ResetEvent
  | SetProviderEvent
  | RenderingFeedbackEvent
  | ComponentActionEvent
  | DialogFeedbackEvent;

// ============ Server → Client Events ============

export interface ActionsEvent {
  type: 'ACTIONS';
  actions: OSAction[];
  agentId?: string;
}

export interface AgentThinkingEvent {
  type: 'AGENT_THINKING';
  content: string;
  agentId?: string;
}

export interface AgentResponseEvent {
  type: 'AGENT_RESPONSE';
  content: string;
  isComplete: boolean;
  agentId?: string;
  messageId?: string;
}

export interface ConnectionStatusEvent {
  type: 'CONNECTION_STATUS';
  status: 'connected' | 'disconnected' | 'error';
  provider?: string;
  sessionId?: string;
  error?: string;
}

export interface ToolProgressEvent {
  type: 'TOOL_PROGRESS';
  toolName: string;
  status: 'running' | 'complete' | 'error';
  message?: string;
  agentId?: string;
}

export interface ErrorEvent {
  type: 'ERROR';
  error: string;
  agentId?: string;
}

export interface WindowAgentStatusEvent {
  type: 'WINDOW_AGENT_STATUS';
  windowId: string;
  agentId: string;
  status: 'assigned' | 'active' | 'released';
}

export interface MessageAcceptedEvent {
  type: 'MESSAGE_ACCEPTED';
  messageId: string;
  agentId: string;
}

export interface MessageQueuedEvent {
  type: 'MESSAGE_QUEUED';
  messageId: string;
  position: number;
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
  | MessageQueuedEvent;
