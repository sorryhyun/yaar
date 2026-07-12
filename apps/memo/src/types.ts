/** Document stored in the `memos` appDb collection. */
export interface MemoDoc {
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** UI-facing memo: a MemoDoc plus its collection document id. */
export interface Memo extends MemoDoc {
  id: string;
}

/** Shape of the legacy memos.json file (pre-appDb). */
export interface MemoStore {
  memos: Memo[];
}
