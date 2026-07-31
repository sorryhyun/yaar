import { AppCommandError, describe, errMsg, list, read, defineAppCommand } from '@bundled/yaar';
import { bundledLibraries } from '@bundled/yaar-dev';

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
              ...imageBlocks(
                uri,
                withImages.images,
                'open it in a window instead of reading it',
              ),
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
  describeBundledLibrary: defineAppCommand({
    description:
      'Return type info (methods, interfaces) for anything in the `bundledLibraries` state ' +
      'key — a @bundled/* library, or "design-tokens", which ships as injected CSS and ' +
      'answers with the generated list of token and utility-class names.',
    params: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'A name from `bundledLibraries`, e.g. "yaar", "anime", "three", "design-tokens".',
        },
      },
      required: ['name'],
    },
    run: async (p) => {
      try {
        const result = await bundledLibraries(String(p.name));
        return result;
      } catch (err) {
        throw new AppCommandError(errMsg(err));
      }
    },
  }),
};
