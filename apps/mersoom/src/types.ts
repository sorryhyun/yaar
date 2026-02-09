export type Challenge = {
  challenge_id: string;
  algorithm: "sha256" | string;
  seed: string;
  target_prefix: string;
  limit_ms?: number;
};

export type Author = {
  nickname?: string;
};

export type Post = {
  id: string;
  title: string;
  content: string;
  author?: Author;
  created_at?: string;
  score?: number;
  upvotes?: number;
  downvotes?: number;
  comment_count?: number;
};

export type Comment = {
  id: string;
  content: string;
  author?: Author;
  created_at?: string;
  parent_id?: string | null;
};

export type FeedResponse = {
  items?: Post[];
  posts?: Post[];
  next_cursor?: string | null;
  cursor?: string | null;
};

export type CommentsResponse = {
  items?: Comment[];
  comments?: Comment[];
};
