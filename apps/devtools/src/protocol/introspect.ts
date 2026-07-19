import { AppCommandError, defineCommand, describe, errMsg, list } from '@bundled/yaar';
import { bundledLibraries } from '@bundled/yaar-dev';
import { clearConsoleLogs } from '../project';

export const introspectCommands = {
  describeUri: defineCommand({
    description: 'Describe a yaar:// URI — returns supported verbs, description, and invoke schema',
    params: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'yaar:// URI to describe (e.g. "yaar://sessions/")',
        },
      },
      required: ['uri'],
    },
    handler: async (p) => {
      try {
        const result = await describe(String(p.uri));
        return { result };
      } catch (err) {
        throw new AppCommandError(`Failed to describe URI ${p.uri}: ${errMsg(err)}`);
      }
    },
  }),
  listUri: defineCommand({
    description: 'List child resources under a yaar:// URI',
    params: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'yaar:// URI to list (e.g. "yaar://sessions/")' },
      },
      required: ['uri'],
    },
    handler: async (p) => {
      try {
        const result = await list(String(p.uri));
        return { items: result };
      } catch (err) {
        throw new AppCommandError(`Failed to list URI ${p.uri}: ${errMsg(err)}`);
      }
    },
  }),
  describeBundledLibrary: defineCommand({
    description: 'Get detailed type information (methods, interfaces) for a @bundled/* library',
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
  clearConsole: defineCommand({
    description: 'Clear console output',
    params: { type: 'object', properties: {} },
    handler: () => {
      clearConsoleLogs();
    },
  }),
};
