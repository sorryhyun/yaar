export {};
import { appStorage, invoke, errMsg } from '@bundled/yaar';
import { activeProject, previewWindowId, staticProtocol } from '../core';
import { projectPath } from '../lib/paths';

// Protocol-manifest inspection: the two truths about an app's protocol and how
// they are compared. The STATIC manifest is what the compiler extracts from
// source (what agents will see after deploy — literal entries only); the
// RUNTIME manifest is what the running preview actually registered via
// app.register(). Drift between them means an entry is reached via a spread or
// computed key: it runs fine but is invisible to agents. Shared by the
// `manifest` command and the best-effort drift check inside `compile`.

export interface ManifestNames {
  commands: string[];
  state: string[];
}

export interface StaticManifestResult {
  names: ManifestNames | null;
  /** Where the static manifest came from, when one was found. */
  source: 'compile' | 'protocol.json' | null;
  /** Why `names` is null, when it is. */
  reason?: string;
}

/**
 * The compiler-extracted manifest: from the last successful compile's response
 * when available, else from a protocol.json reachable in project storage.
 */
export async function getStaticManifest(): Promise<StaticManifestResult> {
  const fromCompile = staticProtocol();
  if (fromCompile?.reported && fromCompile.protocol) {
    return { names: fromCompile.protocol, source: 'compile' };
  }

  // Fall back to a protocol.json the compiler may have written into the project.
  const proj = activeProject();
  if (proj) {
    for (const rel of ['dist/protocol.json', 'protocol.json']) {
      try {
        const parsed = await appStorage.readJsonOr<{
          state?: Record<string, unknown>;
          commands?: Record<string, unknown>;
        } | null>(projectPath(proj.id, rel), null);
        if (parsed && (parsed.commands || parsed.state)) {
          return {
            names: {
              commands: Object.keys(parsed.commands ?? {}),
              state: Object.keys(parsed.state ?? {}),
            },
            source: 'protocol.json',
          };
        }
      } catch {
        /* not there — try the next candidate */
      }
    }
  }

  const reason = !fromCompile
    ? 'No successful compile yet — run compile first; its response carries the extracted protocol.'
    : !fromCompile.reported
      ? 'The compile response did not include a static protocol (the dev API may predate ' +
        'extraction) and no protocol.json was found in the project — recompile, or update the server.'
      : 'The compiler extracted no protocol from source — the app may not call app.register(), ' +
        'or its registration is not statically visible (spreads/computed keys).';
  return { names: null, source: null, reason };
}

export interface RuntimeManifestResult {
  names: ManifestNames | null;
  /** Why `names` is null, when it is. */
  reason?: string;
}

/** The live manifest from the open preview window — what the app actually registered. */
export async function getRuntimeManifest(): Promise<RuntimeManifestResult> {
  const wid = previewWindowId();
  if (!wid) {
    return {
      names: null,
      reason: 'No preview window open — run preview to read the live manifest.',
    };
  }
  try {
    const manifest = await invoke<{
      commands?: Record<string, unknown>;
      state?: Record<string, unknown>;
    } | null>(`yaar://windows/${wid}`, { action: 'app_query', stateKey: 'manifest' });
    if (!manifest || typeof manifest !== 'object') {
      return {
        names: null,
        reason: 'Preview returned no manifest — the app may not call app.register().',
      };
    }
    return {
      names: {
        commands: Object.keys(manifest.commands ?? {}),
        state: Object.keys(manifest.state ?? {}),
      },
    };
  } catch (err) {
    return { names: null, reason: `Preview manifest unreachable: ${errMsg(err)}` };
  }
}

export interface ManifestDrift {
  /** Registered at runtime but absent from the static manifest — invisible to agents. */
  missingFromStatic: string[];
  /** In the static manifest but not registered at runtime — advertised but dead. */
  missingFromRuntime: string[];
}

/**
 * Diff two manifests over command names and state keys. Entries are tagged
 * `command:` / `state:` so the two namespaces cannot collide; `__`-prefixed
 * internal keys are ignored.
 */
export function diffManifestNames(
  staticNames: ManifestNames,
  runtimeNames: ManifestNames,
): ManifestDrift {
  const tag = (m: ManifestNames) => [
    ...m.commands.filter((c) => !c.startsWith('__')).map((c) => `command:${c}`),
    ...m.state.filter((s) => !s.startsWith('__')).map((s) => `state:${s}`),
  ];
  const stat = new Set(tag(staticNames));
  const runtime = new Set(tag(runtimeNames));
  return {
    missingFromStatic: [...runtime].filter((x) => !stat.has(x)),
    missingFromRuntime: [...stat].filter((x) => !runtime.has(x)),
  };
}
