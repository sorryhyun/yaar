import { app, defineCommand } from '@bundled/yaar';
import { memos, addMemo, updateMemo, deleteMemo, searchMemos, getMemoById } from './store';

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'memo',
    name: 'Memo',
    state: {
      memos: {
        description: 'All memos',
        handler: () => ({ memos: memos() }),
      },
      getMemo: {
        description: 'Get a specific memo by id',
        handler: ((params: unknown) => {
          const { id } = (params as { id: string }) ?? {};
          const memo = getMemoById(id);
          return { memo: memo ?? null };
        }) as () => unknown,
      },
      search: {
        description: 'Search memos by keyword',
        handler: ((params: unknown) => {
          const { query } = (params as { query: string }) ?? {};
          return { memos: searchMemos(query ?? '') };
        }) as () => unknown,
      },
    },
    commands: {
      addMemo: defineCommand({
        description: 'Add a new memo',
        params: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['title', 'content'],
        },
        handler: async (p) => {
          const { title, content } = p;
          const memo = await addMemo(title, content);
          return { memo };
        },
      }),
      updateMemo: defineCommand({
        description: 'Update an existing memo',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['id'],
        },
        handler: async (p) => {
          const { id, title, content } = p;
          const memo = await updateMemo(id, title, content);
          return { memo };
        },
      }),
      deleteMemo: defineCommand({
        description: 'Delete a memo by id',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        handler: async (p) => {
          const { id } = p;
          const deleted = await deleteMemo(id);
          return { deleted };
        },
      }),
    },
  });
}
