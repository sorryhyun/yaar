export {};
import { AppCommandError, errMsg } from '@bundled/yaar';
import { findReferences as devFindReferences } from '@bundled/yaar-dev';
import { activeProject, setStatusText } from '../core';
import { projectPath } from '../lib/paths';

export type ReferencesQuery = Parameters<typeof devFindReferences>[1];
export type ReferencesResult = Awaited<ReturnType<typeof devFindReferences>>;

/**
 * References (and optionally callers) of a symbol in the active project, from the
 * TypeScript language service on the dev server. A failed lookup throws with the server's
 * `kind`, so `not-found` and `unavailable` never come back looking like zero references.
 */
export async function findReferences(
  query: ReferencesQuery,
): Promise<Omit<ReferencesResult, 'success'>> {
  const proj = activeProject();
  if (!proj) throw new AppCommandError('No active project. Open or create one first.');
  setStatusText('Finding references...');
  let result: ReferencesResult;
  try {
    result = await devFindReferences(projectPath(proj.id), query);
  } catch (err) {
    setStatusText('Find references failed');
    throw new AppCommandError(`findReferences failed: ${errMsg(err)}`);
  }
  if (!result.success) {
    const reason = `findReferences ${result.kind ?? 'failed'}: ${result.error ?? 'unknown error'}`;
    setStatusText(reason);
    throw new AppCommandError(reason);
  }
  const { success: _ok, ...rest } = result;
  setStatusText(
    `${rest.totalReferences ?? rest.references?.length ?? 0} reference(s) to ${rest.symbol ?? 'symbol'}`,
  );
  // The server names a module-scope caller by its host-absolute file path rather than the
  // documented `(top level)`, which leaks where the sandbox lives and cannot be passed back.
  if (rest.callers) {
    rest.callers = rest.callers.map((c) =>
      c.caller.startsWith('/') ? { ...c, caller: '(top level)' } : c,
    );
  }
  return rest;
}
