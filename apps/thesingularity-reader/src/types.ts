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

/**
 * DCinside 갤러리 내 검색 대상.
 * 모바일 m.dcinside.com 검색 폼의 s_type 값을 그대로 사용한다
 * (데스크톱의 search_subject_memo 형식과 다름 — 모바일은 짧은 값을 쓴다).
 *   subject_m=제목+내용 | subject=제목 | memo=내용 | name=글쓴이 | comment=댓글
 */
export type SearchType = 'subject_m' | 'subject' | 'memo' | 'name' | 'comment';

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

export type Credentials = {
  username: string;
  password: string;
  savedAt: string;
};

export type Recommendation = {
  topics: string[];
  bestPostNum: string | null;
  bestPostReason: string | null;
  analyzedAt: Date;
};
