export type TabMode = 'all' | 'recommend';

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
