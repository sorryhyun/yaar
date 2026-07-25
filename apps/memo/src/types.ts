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

// The legacy memos.json shape is not declared here: it is untrusted input, so
// its only description is the runtime schema in ./schema.ts.
