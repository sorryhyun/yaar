import { app, defineCommand } from '@bundled/yaar';
import { memos, addMemo, updateMemo, deleteMemo, searchMemosFts } from './store';

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'memo',
    name: 'Memo',
    state: {
      // State handlers receive no params — parameterized reads (search, get by
      // id) are commands or direct yaar://apps/memo/db/memos queries instead.
      memos: {
        description: 'All memos',
        handler: () => ({ memos: memos() }),
      },
    },
    commands: {
      searchMemos: defineCommand({
        description: 'Full-text search memos (server-side FTS5), best matches first',
        params: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
        handler: async (p) => {
          const { query, limit } = p;
          return { memos: await searchMemosFts(query, limit) };
        },
      }),
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
