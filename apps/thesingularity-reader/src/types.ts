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
  isNotice: boolean;
};

export type Comment = {
  id: string;
  author: string;
  text: string;
  date: string;
  recommend: string;
  isBest: boolean;
  isReply: boolean;
  /** 모바일 DC 닉네임 타입 */
  nickType?: 'gonick' | 'nogonick' | 'sub-gonick';
  /** DCCon 이모티콘 이미지 URL */
  dcconSrc?: string;
};

export type AppSettings = {
  refreshInterval: number; // in seconds
};

export type AppState = {
  posts: Post[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  newPostCount: number;
  settings: AppSettings;
  selectedPost: Post | null;
  postContent: string | null;
  postLoading: boolean;
};

export type Recommendation = {
  topics: string[];
  bestPostNum: string | null;
  bestPostReason: string | null;
  analyzedAt: Date;
};
