import { AppCommandError, defineCommand, describe, errMsg, list, read } from '@bundled/yaar';
import { bundledLibraries } from '@bundled/yaar-dev';

export const introspectCommands = {
  inspectUri: defineCommand({
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
            'Needs the permission; describe never does.',
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
    handler: async (p) => {
      const uri = String(p.uri);
      try {
        if (p.read) {
          const result = await read(uri);
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
  describeBundledLibrary: defineCommand({
    description: 'Return type info (methods, interfaces) for a @bundled/* library.',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Library name (e.g. "yaar", "anime", "three")' },
      },
      required: ['name'],
    },
    handler: async (p) => {
      try {
        const result = await bundledLibraries(String(p.name));
        return result;
      } catch (err) {
        throw new AppCommandError(errMsg(err));
      }
    },
  }),
};
