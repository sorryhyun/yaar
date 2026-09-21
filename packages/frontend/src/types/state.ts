/**
 * Desktop state - everything that can appear on screen.
 */
import type { AgentKind, WindowBounds, WindowContent, WindowVariant } from '@yaar/shared';

export interface WindowModel {
  id: string;
  title: string;
  bounds: WindowBounds;
  content: WindowContent;
  minimized: boolean;
  maximized: boolean;
  previousBounds?: WindowBounds; // For restore after maximize
  locked?: boolean;
  lockedBy?: string; // Agent ID that holds the lock
  requestId?: string; // For tracking iframe feedback
  monitorId?: string; // Which monitor this window belongs to
  variant?: WindowVariant;
  dockEdge?: 'top' | 'bottom';
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
  iframeToken?: string;
  appId?: string;
  isolateOrigin?: boolean; // Render this app's iframe from the isolated app origin (see WindowState.isolateOrigin)
  appOrigin?: string; // Exact origin for the isolated iframe when the client can't derive it
  /**
   * Bumped by `window.reload`, and used as the content subtree's React key so the bump
   * remounts it. A counter rather than a boolean because a reload has to be repeatable:
   * a flag can only be set once, and the second reload of the same window would render
   * as no change at all.
   */
  reloadNonce?: number;
  /**
   * Bumped whenever an agent changes what the window shows — `setContent`, `updateContent`,
   * or an App Protocol command. The frame keys a one-shot glow on it, so a counter for the
   * same reason as `reloadNonce`: every change has to replay the animation.
   */
  changeNonce?: number;
  /** An agent changed this window while the user wasn't looking at it. Cleared on focus. */
  unseenChange?: boolean;
}

export interface CliEntry {
  id: string;
  /**
   * `notice` is a provider complaint the turn survived (a retry, a denied tool,
   * a hit rate limit) — distinct from `error`, which is the turn's obituary.
   * Rendering the two the same way would make every 529 backoff look like a
   * failed request.
   */
  type: 'user' | 'thinking' | 'response' | 'tool' | 'error' | 'notice' | 'action-summary';
  content: string;
  agentId?: string;
  monitorId: string;
  timestamp: number;
}

export interface Monitor {
  id: string;
  label: string;
  createdAt: number;
}

export interface NotificationModel {
  id: string;
  title: string;
  body: string;
  icon?: string;
  duration?: number;
  timestamp: number;
}

export interface ToastModel {
  id: string;
  message: string;
  variant: 'info' | 'success' | 'warning' | 'error';
  timestamp: number;
  action?: { label: string; eventId: string };
  duration?: number;
}

import type { CapabilityLine, PermissionOptions } from '@yaar/shared';

export interface DialogModel {
  id: string;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  timestamp: number;
  permissionOptions?: PermissionOptions;
  /** Set by the app-install dialog: what is being granted, one row each. */
  capabilities?: CapabilityLine[];
}

export interface UserPromptModel {
  id: string;
  title: string;
  message: string;
  options?: { value: string; label: string; description?: string }[];
  multiSelect?: boolean;
  inputField?: { label?: string; placeholder?: string; type?: 'text' | 'textarea' | 'password' };
  allowDismiss?: boolean;
  /** The monitor whose agent asked. Attribution only — the prompt shows on every monitor. */
  monitorId?: string;
  timestamp: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RestorePrompt {
  sessionId: string;
  sessionDate: string;
}

export interface DebugEntry {
  id: string;
  timestamp: number;
  direction: 'in' | 'out';
  type: string;
  data: unknown;
}

export interface ActiveAgent {
  id: string;
  status: string; // e.g., "Thinking...", "Running: read_file"
  startedAt: number;
  /**
   * When `status` last *changed* — not when it was last re-asserted.
   *
   * `startedAt` measures the whole turn, which on an agentic turn reads the same
   * alarming number whether or not anything is wrong. What distinguishes a stall is
   * how long one phase has been the current one: "Running: Bash 2s" is fine and
   * "Thinking... 90s" is not. The status label is last-event-wins with no heartbeat,
   * so this is the only thing that makes silence visible.
   */
  statusSince: number;
  subagentCount: number; // Active collab subagents (Codex)
  /**
   * Which tier — read off the role for a live agent, sent verbatim by the snapshot.
   * The status bar's only color axis; see `DesktopStatusBar`.
   */
  kind: AgentKind;
  /**
   * The monitor this agent is working for, when the event said. Every tier but
   * `session` names one, so a chip without a number is the session agent.
   */
  monitorId?: string;
}

export interface WindowAgent {
  agentId: string;
  windowId: string;
  status: 'assigned' | 'active' | 'released';
}

export interface RenderingFeedback {
  requestId: string;
  windowId: string;
  renderer: string;
  success: boolean;
  error?: string;
  url?: string;
  locked?: boolean;
  imageData?: string;
  /** Why a capture produced no image. See RenderingFeedbackEvent.captureFailure. */
  captureFailure?: string;
}

export interface QueuedComponentAction {
  windowId: string;
  windowTitle: string;
  action: string;
  parallel?: boolean;
  formData?: Record<string, string | number | boolean>;
  formId?: string;
  componentPath?: string[];
  queuedAt: number;
}
