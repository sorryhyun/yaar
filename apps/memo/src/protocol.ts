import { app } from '@bundled/yaar';
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
      addMemo: {
        description: 'Add a new memo',
        params: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['title', 'content'],
        },
        handler: async (p: unknown) => {
          const { title, content } = p as { title: string; content: string };
          const memo = await addMemo(title, content);
          return { memo };
        },
      },
      updateMemo: {
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
        handler: async (p: unknown) => {
          const { id, title, content } = p as { id: string; title?: string; content?: string };
          const memo = await updateMemo(id, title, content);
          return { memo };
        },
      },
      deleteMemo: {
        description: 'Delete a memo by id',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        handler: async (p: unknown) => {
          const { id } = p as { id: string };
          const deleted = await deleteMemo(id);
          return { deleted };
        },
      },
    },
  });
}
