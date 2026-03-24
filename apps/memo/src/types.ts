export interface Memo {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoStore {
  memos: Memo[];
}
