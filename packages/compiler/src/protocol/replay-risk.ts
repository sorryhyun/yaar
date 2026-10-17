/**
 * The compile-time half of `listReplayRisks` (`@yaar/shared`): one warning naming every
 * command whose name reads as one-shot but whose replay policy was left to the default.
 *
 * A warning, never a refusal — the verdict comes from a command's name, and a name is
 * evidence, not proof. It exists because the failure it predicts is silent and lasting:
 * an `addNode` that persists its node is re-run on every remount, and each run persists
 * another copy.
 */
import type { AppManifest } from '@yaar/shared';
import { listReplayRisks } from '@yaar/shared';

export function replayRiskWarning(protocol: Pick<AppManifest, 'commands'>): string | null {
  const risky = listReplayRisks(protocol.commands);
  if (risky.length === 0) return null;
  return (
    `protocol: ${risky.join(', ')} ${risky.length === 1 ? 'declares' : 'declare'} no \`replay\` ` +
    'policy, so a remounted iframe (reload, reconnect, a second browser) is sent ' +
    `${risky.length === 1 ? 'it' : 'them'} again, and a command whose effect the app ` +
    'persists itself (appDb, storage) is applied once more on every remount. Declare ' +
    "`replay: 'never'` on each (or once on defineApp, for every command), or " +
    "`replay: 'always'` where re-running only restores the view."
  );
}
