/**
 * `YAAR_WORKSPACE` — a workspace is exactly a bundle of the four state-root env
 * overrides, nothing more.
 *
 * Two properties matter enough to pin:
 *
 * - **The derived paths all live under one directory.** The point of a workspace is
 *   that deleting `workspaces/<name>/` deletes the whole experiment; a derived path
 *   that escapes the base would leave state behind after the "disposable" directory
 *   is gone.
 * - **A bad name is refused, not defaulted.** Falling back to the default roots on an
 *   invalid name would write the experiment's state into the very directories the
 *   workspace existed to protect — with every signal green.
 *
 * The application itself (fill-in-if-unset onto `process.env` at module load) is not
 * re-run here: `env.ts` evaluates once per process and the test env pins the path vars
 * explicitly, which is itself the fill-in contract doing its job.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { workspaceNameRefusal, workspaceEnvDefaults } from '../config/env.js';

describe('workspaceNameRefusal', () => {
  it('accepts plain segment names', () => {
    for (const name of ['game-dev', 'exp1', 'a', '3d.studio', 'My_Workspace']) {
      expect(workspaceNameRefusal(name)).toBeNull();
    }
  });

  it('refuses anything that is not a safe path segment', () => {
    for (const name of ['', '..', '.hidden', '-lead', 'a/b', 'a\\b', 'a b', '한글']) {
      expect(workspaceNameRefusal(name)).not.toBeNull();
    }
  });
});

describe('workspaceEnvDefaults', () => {
  it('derives all four state roots under workspaces/<name>/', () => {
    const root = join('/tmp', 'proj');
    const defaults = workspaceEnvDefaults('game-dev', root);
    const base = join(root, 'workspaces', 'game-dev');
    expect(defaults).toEqual({
      YAAR_STORAGE: join(base, 'storage'),
      YAAR_CONFIG: join(base, 'config'),
      YAAR_SESSION_LOGS: join(base, 'session_logs'),
      YAAR_USER_APPS: join(base, 'user-apps'),
    });
  });

  it('covers exactly the vars the test env pins, plus user-apps', () => {
    // If a fifth state root ever joins the bundle, scripts/test/env.ts must pin it
    // too — this assertion is the reminder.
    expect(Object.keys(workspaceEnvDefaults('x', '/p')).sort()).toEqual([
      'YAAR_CONFIG',
      'YAAR_SESSION_LOGS',
      'YAAR_STORAGE',
      'YAAR_USER_APPS',
    ]);
  });
});
