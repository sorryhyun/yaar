/**
 * Browser automation types.
 */

export interface PageState {
  url: string;
  title: string;
  textSnippet: string;
  activeElement?: { tag: string; id?: string; name?: string; type?: string };
  urlChanged?: boolean;
  clickTarget?: {
    tag: string;
    text: string;
    candidateCount: number;
    selector?: string;
    href?: string;
  };
  scrollY?: number;
  scrollHeight?: number;
  viewportHeight?: number;
  visibleLinks?: Array<{ text: string; href: string }>;
  newTab?: { browserId: string; url: string };
}

export interface PageContent {
  url: string;
  title: string;
  fullText: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string; fields: Array<{ name: string; type: string; value?: string }> }>;
}
