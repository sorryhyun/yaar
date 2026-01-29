/**
 * WebSocket event types for client-server communication.
 */

import type { OSAction } from './actions.js';

// ============ Client → Server Events ============

export interface UserMessageEvent {
  type: 'USER_MESSAGE';
  content: string;
}

export interface InterruptEvent {
  type: 'INTERRUPT';
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
}

export type ClientEvent = UserMessageEvent | InterruptEvent | SetProviderEvent | RenderingFeedbackEvent;

// ============ Server → Client Events ============

export interface ActionsEvent {
  type: 'ACTIONS';
  actions: OSAction[];
}

export interface AgentThinkingEvent {
  type: 'AGENT_THINKING';
  content: string;
}

export interface AgentResponseEvent {
  type: 'AGENT_RESPONSE';
  content: string;
  isComplete: boolean;
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
}

export type ServerEvent =
  | ActionsEvent
  | AgentThinkingEvent
  | AgentResponseEvent
  | ConnectionStatusEvent
  | ToolProgressEvent
  | RequestPermissionEvent
  | ErrorEvent;
