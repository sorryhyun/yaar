import { AppCommandError, describe, errMsg, list, read, defineAppCommand } from '@bundled/yaar';
import { bundledLibraries } from '@bundled/yaar-dev';
import { readModelSummary } from '../services';

import { imageBlocks, imagesFromReadResult } from './read-blocks';

export const introspectCommands = {
  'inspect/uri': defineAppCommand({
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
  'inspect/model': defineAppCommand({
    description:
      'Read a .glb/.gltf file as line-oriented JSON: node tree with TRS, mesh bounds and ' +
      'counts, materials, textures, extras, and each clip with the nodes it keys — no compile ' +
      'needed. `node`, `keys` and `pose` drill into one subtree, clip or moment (the ' +
      'static-assets topic); trust `measured` over `units` for scale and facing.',
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
  'inspect/library': defineAppCommand({
    description:
      'Type info for a @bundled/* library, or "design-tokens" (the generated token and ' +
      'utility-class names). Without `name`, the list of names it accepts. A sectioned ' +
      'library ("yaar", "yaar-web") answers with an index of sections and exports; pass ' +
      '`symbol` for one export with the types it references, `section` for one section, or ' +
      '`full: true` for everything.',
    params: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'e.g. "yaar", "anime", "three", "design-tokens". Omit to list them all.',
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
    },
    run: async (p) => {
      try {
        if (typeof p.name !== 'string' || !p.name) return { libraries: await bundledLibraries() };
        return await bundledLibraries(p.name, {
          symbol: typeof p.symbol === 'string' ? p.symbol : undefined,
          section: typeof p.section === 'string' ? p.section : undefined,
          full: p.full === true,
        });
      } catch (err) {
        throw new AppCommandError(errMsg(err));
      }
    },
  }),
};
