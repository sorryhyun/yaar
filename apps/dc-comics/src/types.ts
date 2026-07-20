export type TabMode = 'all' | 'recommend';

export type AppSettings = {
  refreshInterval: number; // in seconds
};

export type Post = {
  id: string;
  num: string;
  title: string;
  url: string;
  category?: string;
  author: string;
  date: string;
  views: string;
  recommend: string;
  comments: string;
  isNotice: boolean;
  hasImage: boolean;
};

export type Comment = {
  id: string;
  author: string;
  text: string;
  date: string;
  recommend: string;
  isBest: boolean;
  isReply: boolean;
  nickType?: 'gonick' | 'nogonick' | 'sub-gonick';
  dcconSrc?: string;
};

/**
 * A per-image comment (짤방댓글). DC attaches a comment thread to each image in a
 * post; on a comic gallery these are a large part of the fun, so they are
 * surfaced under each image in the viewer.
 */
export type ImgComment = {
  id: string;
  author: string;
  text: string;
  date: string;
  nickType?: 'gonick' | 'nogonick' | 'sub-gonick';
};

/** Per-image comments for one post, keyed by DC's image fileno. */
export type ImgCommentMap = Record<string, ImgComment[]>;

export type SeriesLink = {
  title: string;
  url: string;
};

export type SeriesPost = {
  id: string;
  title: string;
  date: string;
  isNew: boolean;
};

export type Subscription = {
  id: string;
  title: string;
  url: string;
  gallId: string;
  lastPostId: string;
  subscribedAt: string;
  unreadCount: number;
  latestPosts: SeriesPost[];
};
