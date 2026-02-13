/**
 * Browser automation types.
 */

export interface PageState {
  url: string;
  title: string;
  textSnippet: string;
}

export interface PageContent {
  url: string;
  title: string;
  fullText: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string; fields: Array<{ name: string; type: string; value?: string }> }>;
}
