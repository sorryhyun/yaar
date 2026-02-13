export type PaperSource = 'huggingface' | 'arxiv';

export type DailyPaperItem = {
  source?: PaperSource;
  paper?: {
    id?: string;
    title?: string;
    summary?: string;
    publishedAt?: string;
    ai_summary?: string;
    upvotes?: number;
    authors?: Array<{ name?: string }>;
  };
  id?: string;
  title?: string;
  summary?: string;
  publishedAt?: string;
  thumbnail?: string;
  numComments?: number;
  upvotes?: number;
  submittedBy?: { fullname?: string; name?: string };
  organization?: { fullname?: string; name?: string };
  arxiv?: {
    absUrl?: string;
    pdfUrl?: string;
    primaryCategory?: string;
    authors?: string[];
  };
};

export type Recommendation = {
  id: string;
  title: string;
  reason: string;
  upvotes: number;
  comments: number;
  source?: PaperSource;
  url?: string;
};

export type PaperDetails = {
  id: string;
  title: string;
  summary: string;
  aiSummary: string;
  keywords: string[];
  authors: string[];
  upvotes: number;
  publishedAt: string;
  projectPage: string;
  githubRepo: string;
  githubStars: number;
  links: {
    huggingFace: string;
    arxiv: string;
  };
};
