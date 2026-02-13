import type { DailyPaperItem, PaperDetails } from './types';
import { getApiSort, getFirstText, normalizeText, parseArxivIdFromUrl } from './paper-utils';

export async function fetchArxivPapers(limit: number, queryValue: string, sortByValue: string): Promise<DailyPaperItem[]> {
  const rawQuery = normalizeText(queryValue || 'cat:cs.AI OR cat:cs.LG');
  const query = rawQuery || 'cat:cs.AI OR cat:cs.LG';

  const sortBy = sortByValue === 'newest' ? 'submittedDate' : 'lastUpdatedDate';
  const sortOrder = sortByValue === 'oldest' ? 'ascending' : 'descending';
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${Math.max(1, limit)}&sortBy=${sortBy}&sortOrder=${sortOrder}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`arXiv HTTP ${resp.status}`);
  const xml = await resp.text();

  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error('arXiv feed parse error');

  const entries = Array.from(doc.getElementsByTagName('entry'));
  return entries.map((entry) => {
    const absUrl = getFirstText(entry, 'id');
    const id = parseArxivIdFromUrl(absUrl);
    const title = getFirstText(entry, 'title');
    const summary = getFirstText(entry, 'summary');
    const publishedAt = getFirstText(entry, 'published') || getFirstText(entry, 'updated');

    const authorNodes = Array.from(entry.getElementsByTagName('author'));
    const authors = authorNodes.map((a) => getFirstText(a, 'name')).filter(Boolean);

    const links = Array.from(entry.getElementsByTagName('link'));
    const pdfLink = links.find((l) => l.getAttribute('title') === 'pdf')?.getAttribute('href') || '';

    const primaryCategoryNode = entry.getElementsByTagName('arxiv:primary_category')[0] || entry.getElementsByTagName('primary_category')[0];
    const primaryCategory = primaryCategoryNode?.getAttribute('term') || '';

    return {
      source: 'arxiv' as const,
      id,
      title,
      summary,
      publishedAt,
      upvotes: 0,
      numComments: 0,
      arxiv: {
        absUrl: absUrl || `https://arxiv.org/abs/${id}`,
        pdfUrl: pdfLink || `https://arxiv.org/pdf/${id}.pdf`,
        primaryCategory,
        authors,
      },
    };
  });
}

export async function fetchHfPapers(limit: number, sortByValue: string): Promise<DailyPaperItem[]> {
  const apiSort = getApiSort(sortByValue);
  const resp = await fetch(`https://huggingface.co/api/daily_papers?limit=${limit}&sort=${apiSort}`);
  if (!resp.ok) throw new Error(`HF HTTP ${resp.status}`);
  const data = (await resp.json()) as DailyPaperItem[];
  return (Array.isArray(data) ? data : []).map((item) => ({ ...item, source: 'huggingface' as const }));
}

export async function fetchPaperDetailsById(id: string, cache: Record<string, PaperDetails>) {
  const cleanId = String(id || '').trim();
  if (!cleanId) throw new Error('Missing paper id');

  if (cache[cleanId]) return cache[cleanId];

  const resp = await fetch(`https://huggingface.co/api/papers/${encodeURIComponent(cleanId)}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();

  const normalized: PaperDetails = {
    id: data?.id || cleanId,
    title: data?.title || '',
    summary: data?.summary || '',
    aiSummary: data?.ai_summary || '',
    keywords: Array.isArray(data?.ai_keywords) ? data.ai_keywords : [],
    authors: Array.isArray(data?.authors) ? data.authors.map((a: any) => a?.name).filter(Boolean) : [],
    upvotes: Number(data?.upvotes || 0),
    publishedAt: data?.publishedAt || '',
    projectPage: data?.projectPage || '',
    githubRepo: data?.githubRepo || '',
    githubStars: Number(data?.githubStars || 0),
    links: {
      huggingFace: `https://huggingface.co/papers/${data?.id || cleanId}`,
      arxiv: `https://arxiv.org/abs/${data?.id || cleanId}`,
    },
  };

  cache[cleanId] = normalized;
  return normalized;
}
