/**
 * WebSocket event types for client-server communication.
 */

import type { OSAction } from './actions.js';

// ============ Client → Server Events ============

export interface UserInteraction {
  type: 'window.close' | 'window.focus' | 'window.move' | 'window.resize' | 'window.minimize' | 'window.maximize' | 'toast.dismiss' | 'notification.dismiss' | 'icon.click';
  timestamp: number;
  windowId?: string;
  windowTitle?: string;
  details?: string;
}

export interface UserMessageEvent {
  type: 'USER_MESSAGE';
  content: string;
  interactions?: UserInteraction[];
}

export interface WindowMessageEvent {
  type: 'WINDOW_MESSAGE';
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
}

export interface ComponentActionEvent {
  type: 'COMPONENT_ACTION';
  windowId: string;
  action: string;
}

export type ClientEvent =
  | UserMessageEvent
  | WindowMessageEvent
  | InterruptEvent
  | InterruptAgentEvent
  | SetProviderEvent
  | RenderingFeedbackEvent
  | ComponentActionEvent;

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

export interface RequestPermissionEvent {
  type: 'REQUEST_PERMISSION';
  id: string;
  action: string;
  description: string;
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
  status: 'created' | 'active' | 'idle' | 'destroyed';
}

export type ServerEvent =
  | ActionsEvent
  | AgentThinkingEvent
  | AgentResponseEvent
  | ConnectionStatusEvent
  | ToolProgressEvent
  | RequestPermissionEvent
  | ErrorEvent
  | WindowAgentStatusEvent;
