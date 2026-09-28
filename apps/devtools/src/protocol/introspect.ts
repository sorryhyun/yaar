import { AppCommandError, describe, errMsg, list, read, defineAppCommand } from '@bundled/yaar';
import { bundledLibraries } from '@bundled/yaar-dev';
import { readModelSummary } from '../services';

import { imageBlocks, imagesFromReadResult } from './read-blocks';

export const introspectCommands = {
  inspectUri: defineAppCommand({
    description:
      'Inspect a yaar:// URI. Default: describe — returns supported verbs and invoke schema. ' +
      'read: true — returns the resource content (e.g. a yaar://skills/{topic} doc). ' +
      'list: true — returns child resources instead.',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'yaar:// URI (e.g. "yaar://skills/components")' },
        read: {
          type: 'boolean',
          description:
            'Read the resource content instead of describing it. Takes precedence over list. ' +
            'Needs the permission; describe never does. An image resource comes back as a ' +
            'viewable image block, not base64 text.',
        },
        list: {
          type: 'boolean',
          description: 'List children instead of describing. Default false.',
        },
      },
      required: ['uri'],
    },
    // describe/list alone could not fetch a document, so the prompt's instruction to
    // read a skill topic before writing app code had no command behind it: `list` on
    // a topic URI is not even a verb the handler serves, and the 403 for it read as
    // the doc being off-limits rather than absent.
    run: async (p) => {
      const uri = String(p.uri);
      try {
        if (p.read) {
          const result = await read(uri);
          // A PNG, or a rasterized PDF page, is answered with the picture. The verb SDK
          // splits an image-bearing envelope into `{ data, images }`; returning that object
          // would stringify the base64 into a text block — and one long enough to be
          // truncated, so not even decodable. Image blocks pass through the app protocol.
          const withImages = imagesFromReadResult(result);
          if (withImages) {
            const preamble = withImages.text
              ? [{ type: 'text' as const, text: withImages.text }]
              : [];
            return [
              ...preamble,
              ...imageBlocks(uri, withImages.images, 'open it in a window instead of reading it'),
            ];
          }
          return { content: result };
        }
        if (p.list) {
          const result = await list(uri);
          return { items: result };
        }
        const result = await describe(uri);
        return { result };
      } catch (err) {
        throw new AppCommandError(`Failed to inspect URI ${uri}: ${errMsg(err)}`);
      }
    },
  }),
  inspectModel: defineAppCommand({
    description:
      'Read a .glb/.gltf model as data: node tree with local TRS, per-mesh local and world ' +
      'bounds, vertex/triangle counts, materials, texture sizes, extras (where files keep ' +
      'event markers), and each animation clip with its duration and the node paths it keys. ' +
      'Reads the file itself — no compile or preview needed. `node` scopes it to a subtree and ' +
      'adds per-channel keyframe stats (first/last/min/max, degrees of swing, near-instant ' +
      "jumps such as a hide by scale); `keys` returns one clip's keyframes, windowed by " +
      '`range` and resampled by `step`. `pose` plays a clip: with `at`, every node in world ' +
      "space and the posed mesh bounds (skinned meshes included) at that time; without, `node`'s " +
      'world path over the clip — how you check motion without building. `units` is the glTF ' +
      'convention; `measured` says what the bounds suggest (centimetres, a −Z front). ' +
      'Line-oriented JSON, one record per line.',
    params: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project path (e.g. "src/assets/rifle.glb") or a yaar://storage/... URI.',
        },
        node: {
          type: 'string',
          description:
            'Node name (exact, case-insensitive, or a unique substring) or "#index": scope ' +
            'the summary to its subtree. The node whose world path `pose` samples.',
        },
        depth: { type: 'number', description: 'Levels of the node tree to list.' },
        keys: {
          type: 'string',
          description:
            'Animation name or "#index": return its keyframes as [time, ...value] rows — ' +
            'only the channels under `node` when that is set.',
        },
        pose: {
          type: 'string',
          description:
            'Animation name or "#index" to play into a world-space pose: a snapshot with ' +
            "`at`, else `node`'s world path over the clip.",
        },
        at: { type: 'number', description: 'Seconds into the `pose` clip for the snapshot.' },
        range: {
          type: 'string',
          description:
            'Time window in seconds, e.g. "0.2-0.8" (an end may be open), for `keys` rows ' +
            'and a pose path.',
        },
        step: {
          type: 'number',
          description:
            'Resample `keys` rows (and a pose path) every this many seconds, interpolated as ' +
            'three.js plays them, instead of listing raw keys.',
        },
        euler: {
          type: 'boolean',
          description: 'Rotations as XYZ Euler degrees (three.js default order), not quaternions.',
        },
        omit: {
          type: 'string',
          description:
            'Sections to leave out, comma-separated: nodes, meshes, materials, images, ' +
            'animations, skins, cameras, lights.',
        },
      },
      required: ['path'],
    },
    run: async (p) => {
      const path = String(p.path);
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
      try {
        return await readModelSummary(path, {
          node: str(p.node),
          depth: num(p.depth),
          keys: str(p.keys),
          pose: str(p.pose),
          at: num(p.at),
          range: str(p.range),
          step: num(p.step),
          euler: typeof p.euler === 'boolean' ? p.euler : undefined,
          omit: Array.isArray(p.omit) ? p.omit.join(',') : str(p.omit),
        });
      } catch (err) {
        throw new AppCommandError(`Failed to inspect model ${path}: ${errMsg(err)}`);
      }
    },
  }),
  describeBundledLibrary: defineAppCommand({
    description:
      'Return type info for anything in the `bundledLibraries` state key — a @bundled/* ' +
      'library, or "design-tokens" (the generated token and utility-class names). A sectioned ' +
      'library ("yaar", "yaar-web") answers with an index of sections and exports; pass ' +
      '`symbol` for one export with the types it references, `section` for one section, or ' +
      '`full: true` for everything.',
    params: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'A name from `bundledLibraries`, e.g. "yaar", "anime", "three", "design-tokens".',
        },
        symbol: {
          type: 'string',
          description: 'One export by exact name, e.g. "createSharedSignal".',
        },
        section: {
          type: 'string',
          description: 'A section title from the index (case-insensitive, partial match).',
        },
        full: { type: 'boolean', description: 'The whole declaration instead of the index.' },
      },
      required: ['name'],
    },
    run: async (p) => {
      try {
        const result = await bundledLibraries(String(p.name), {
          symbol: typeof p.symbol === 'string' ? p.symbol : undefined,
          section: typeof p.section === 'string' ? p.section : undefined,
          full: p.full === true,
        });
        return result;
      } catch (err) {
        throw new AppCommandError(errMsg(err));
      }
    },
  }),
};
