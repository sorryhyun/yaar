// ---- Types ----

export interface Feed {
  id: string;
  name: string;
  url: string;
  favicon?: string;
}

export interface Article {
  id: string;
  feedId: string;
  feedName: string;
  title: string;
  link: string;
  pubDate: string;
  author: string;
  description: string;
  content: string;
  thumbnail?: string;
}

export interface AppState {
  feeds: Feed[];
  readArticleIds: string[];
}
