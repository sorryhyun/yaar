import { AppCommandError, defineCommand, describe, errMsg, list } from '@bundled/yaar';
import { bundledLibraries } from '@bundled/yaar-dev';

export const introspectCommands = {
  inspectUri: defineCommand({
    description:
      'Inspect a yaar:// URI. Default: describe — returns supported verbs and invoke schema. ' +
      'list: true — returns child resources instead.',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'yaar:// URI (e.g. "yaar://sessions/")' },
        list: {
          type: 'boolean',
          description: 'List children instead of describing. Default false.',
        },
      },
      required: ['uri'],
    },
    handler: async (p) => {
      const uri = String(p.uri);
      try {
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
