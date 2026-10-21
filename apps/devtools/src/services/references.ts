export {};
import { AppCommandError, errMsg } from '@bundled/yaar';
import { findReferences as devFindReferences, typeAt as devTypeAt } from '@bundled/yaar-dev';
import { requireProject, setStatusText } from '../core';
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
  const proj = requireProject(AppCommandError);
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

export type TypeAtQuery = Parameters<typeof devTypeAt>[1];
export type TypeAtResult = Awaited<ReturnType<typeof devTypeAt>>;

/**
 * The checker's hover text at one position in the active project — the same language
 * service as `findReferences`, so it reads saved files and needs no compile. Throws with
 * the server's `kind` on failure, for the same reason.
 */
export async function typeAt(query: TypeAtQuery): Promise<Omit<TypeAtResult, 'success'>> {
  const proj = requireProject(AppCommandError);
  let result: TypeAtResult;
  try {
    result = await devTypeAt(projectPath(proj.id), query);
  } catch (err) {
    throw new AppCommandError(`typeAt failed: ${errMsg(err)}`);
  }
  if (!result.success) {
    throw new AppCommandError(
      `typeAt ${result.kind ?? 'failed'}: ${result.error ?? 'unknown error'}`,
    );
  }
  const { success: _ok, ...rest } = result;
  return rest;
}
