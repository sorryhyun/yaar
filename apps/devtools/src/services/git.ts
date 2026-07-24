export {};
import { AppCommandError } from '@bundled/yaar';
import {
  gitHistory as devGitHistory,
  gitDiff as devGitDiff,
  gitRestore as devGitRestore,
  gitCheckpoint as devGitCheckpoint,
} from '@bundled/yaar-dev';
import { setStatusText } from '../core';

// ── Version history ──
//
// Deploys are snapshotted into a per-app shadow git repo (metadata lives outside
// the app dir, so the user's own repo is never touched). These target a deployed
// *app*, not the sandbox project — the boundary is the app directory itself.

export async function gitHistory(appId: string, limit?: number) {
  const result = await devGitHistory(appId, limit ? { limit } : undefined);
  if (!result.success) throw new AppCommandError(result.error ?? 'Failed to read history');
  return result.commits ?? [];
}

export async function gitDiff(
  appId: string,
  opts?: { ref?: string; against?: 'snapshot' | 'repo' },
) {
  const result = await devGitDiff(appId, opts);
  if (!result.success) throw new AppCommandError(result.error ?? 'Failed to diff');
  return result;
}

export async function gitRestore(appId: string, ref: string) {
  setStatusText(`Restoring ${appId} to ${ref}...`);
  const result = await devGitRestore(appId, ref);
  if (!result.success) {
    setStatusText(`Restore failed: ${result.error ?? 'Unknown'}`);
    throw new AppCommandError(result.error ?? 'Failed to restore');
  }
  setStatusText(
    result.recompiled
      ? `Restored ${appId} to ${result.ref?.slice(0, 7)}`
      : `Restored ${appId} (rebuild failed — see compileError)`,
  );
  return result;
}

export async function gitCheckpoint(appId: string, message?: string) {
  const result = await devGitCheckpoint(appId, message ? { message } : undefined);
  if (!result.success) throw new AppCommandError(result.error ?? 'Failed to checkpoint');
  return result.commits?.[0] ?? null;
}
