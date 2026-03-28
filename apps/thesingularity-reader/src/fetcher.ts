/**
 * fetcher.ts — Mobile DCinside post & comment scraper
 *
 * All fetching targets m.dcinside.com (mobile). Desktop selectors are not
 * included because the browser tabs are always opened with `mobile: true`.
 *
 * Approach: yaar-web opens a headless browser tab, navigates to the gallery
 * page, and returns raw HTML. We parse it client-side with DOMParser rather
 * than relying on evaluate() — this keeps scraping logic testable and avoids
 * CSP issues inside the target page.
 */
import type { Post, Comment } from './types';
import * as web from '@bundled/yaar-web';
import { openOrNavigate, MAIN_TAB, postTabId } from './browser';

const GALLERY_ID = 'thesingularity';
const GALLERY_URL = `https://m.dcinside.com/board/${GALLERY_ID}`;

async function browseUrl(url: string, tabId: string, waitForIdle = false): Promise<string> {
  await openOrNavigate(url, tabId, {
    visible: false,
    mobile: true,
    ...(waitForIdle && { waitUntil: 'networkidle' }),
  });
  const result = (await web.html({ browserId: tabId })) as { ok: boolean; data?: string };
  return result?.data ?? '';
}

/** True if the line is pure metadata (number, date, view/recommend label, icon text). */
function isMetaLine(line: string): boolean {
  if (line.length <= 1) return true;
  if (/^\d+$/.test(line)) return true;
  if (/^\d{2}:\d{2}/.test(line)) return true;
  if (/^\d{4}\.\d{2}/.test(line)) return true;
  if (/^\d{2}\.\d{2}/.test(line)) return true;
  if (/^조회/.test(line)) return true;
  if (/^추천/.test(line)) return true;
  if (line === '이미지' || line === '동영상' || line === '설문' || line === 'AD') return true;
  return false;
}

// Selectors for metadata elements to strip when extracting title text.
// Wildcards are intentional — mobile DC nests view count, recommend, author,
// etc. inside the title link with varying class names.
const META_SELECTORS = [
  '.view-cnt',
  '.recommend-cnt',
  '.num-date',
  '.gall-num',
  '.gall-cnt',
  '.gall-writer',
  '.gall-info',
  '.rply-num',
  '.reply-num',
  '[class*="view"]',
  '[class*="recom"]',
  '[class*="cnt"]',
  '[class*="writer"]',
  '[class*="info"]',
  '[class*="num"]',
].join(', ');

export async function fetchPosts(page = 1): Promise<Post[]> {
  const url = page > 1 ? `${GALLERY_URL}?page=${page}` : GALLERY_URL;
  const html = await browseUrl(url, MAIN_TAB);
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const listEl = doc.querySelector('ul.gall-detail-lst');
  if (!listEl) return [];
  const liItems = Array.from(listEl.querySelectorAll(':scope > li'));

  const posts: Post[] = [];

  for (const li of liItems) {
    if (li.classList.contains('advert') || li.querySelector('.ad-wrap, .aderror')) continue;

    const aEl =
      (li.querySelector(
        `a[href*="/board/"][href*="/${GALLERY_ID}/"]:not([href*="#"])`,
      ) as HTMLAnchorElement | null) ??
      (li.querySelector('a[href*="/board/"]') as HTMLAnchorElement | null);
    if (!aEl) continue;

    const href = aEl.getAttribute('href') ?? '';
    const urlMatch = href.match(/\/board\/[^/]+\/(\d+)\/?(?:\?.*)?$/);
    if (!urlMatch) continue;
    const num = urlMatch[1];
    if (!num || !/^\d+$/.test(num)) continue;

    const fullUrl = href.startsWith('http') ? href : 'https://m.dcinside.com' + href;

    // --- Views & recommend ---
    let views = '0';
    let recommend = '0';

    const viewEl = li.querySelector('.view-cnt');
    const recEl = li.querySelector('.recommend-cnt');

    if (viewEl) {
      const m = (viewEl.textContent ?? '').match(/(\d+)/);
      if (m) views = m[1];
    }
    if (recEl) {
      const m = (recEl.textContent ?? '').match(/(\d+)/);
      if (m) recommend = m[1];
    }

    // Regex fallback when DOM selectors miss (e.g. markup changes)
    if (views === '0' && recommend === '0') {
      const liText = li.textContent ?? '';
      const viewsMatch = liText.match(/조회\s*(\d+)/);
      const recMatch = liText.match(/추천\s*(\d+)/);
      if (viewsMatch) views = viewsMatch[1];
      if (recMatch) recommend = recMatch[1];
    }

    // --- Title ---
    let titleRaw = '';

    const titleEl = aEl.querySelector('.gall-tit-txt');
    if (titleEl) {
      const clone = titleEl.cloneNode(true) as Element;
      clone.querySelectorAll(META_SELECTORS).forEach((el) => el.remove());
      clone.querySelectorAll('em, i, b').forEach((el) => {
        if (isMetaLine((el.textContent ?? '').trim())) el.remove();
      });
      titleRaw = (clone.textContent ?? '').trim();
    }

    // Fallback: strip metadata from the entire link element
    if (!titleRaw) {
      const aClone = aEl.cloneNode(true) as Element;
      aClone.querySelectorAll(META_SELECTORS).forEach((el) => el.remove());
      aClone.querySelectorAll('span, em, i, b').forEach((el) => {
        const t = (el.textContent ?? '').trim();
        if (/^조회/.test(t) || /^추천/.test(t) || isMetaLine(t)) el.remove();
      });

      const contentLines = (aClone.textContent ?? '')
        .split(/\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((l) => !isMetaLine(l));

      if (contentLines.length > 0) {
        titleRaw = contentLines.reduce((a, b) => (b.length > a.length ? b : a), contentLines[0]);
      }

      if (!titleRaw) titleRaw = '(제목 없음)';
    }

    // Category from [bracket] prefix
    const titleCategoryMatch = titleRaw.match(/^\[([^\]]+)\]/);
    const categoryFromTitle = titleCategoryMatch ? titleCategoryMatch[1].trim() : '';
    const title = titleCategoryMatch
      ? titleRaw.slice(titleCategoryMatch[0].length).trim()
      : titleRaw;

    // --- Author & date ---
    let author = '익명';
    let date = '';
    let category: string | undefined = categoryFromTitle || undefined;

    // data-nick on non-anchor elements (anchors may carry an empty data-nick)
    const nonAnchorNickEls = Array.from(li.querySelectorAll('[data-nick]')).filter(
      (el) => el.tagName !== 'A',
    );
    const writerEl: Element | null =
      nonAnchorNickEls.find((el) => (el.getAttribute('data-nick') ?? '').trim() !== '') ??
      li.querySelector('.gall-writer') ??
      nonAnchorNickEls[0] ??
      null;
    const dateEl = li.querySelector('.num-date');

    if (writerEl) {
      const dataNick = writerEl.getAttribute('data-nick') ?? '';
      if (dataNick) {
        author = dataNick;
      } else {
        const writerClone = writerEl.cloneNode(true) as Element;
        writerClone.querySelectorAll('img, i, em').forEach((e) => {
          if (isMetaLine((e.textContent ?? '').trim())) e.remove();
        });
        author = (writerClone.textContent ?? '').trim() || '익명';
      }
    }
    if (dateEl) {
      date = (dateEl.textContent ?? '').trim();
    }

    // .ginfo: mobile DC packs "category author date views recommend" as flat text
    if (author === '익명') {
      const ginfoEl = li.querySelector('.ginfo');
      if (ginfoEl) {
        let ginfoText = (ginfoEl.textContent ?? '').trim();
        ginfoText = ginfoText.replace(/\s*조회\s*\d+.*$/, '');
        ginfoText = ginfoText.replace(/\s+\d{2}[:.]\d{2}\s*$/, '');
        ginfoText = ginfoText.replace(/\s+\d{4}\.\d{2}\.\d{2}\s*$/, '');
        ginfoText = ginfoText.replace(/\s+\d{2}\.\d{2}\s*$/, '');
        ginfoText = ginfoText.trim();
        if (ginfoText) {
          const parts = ginfoText.split(/\s+/);
          if (parts.length >= 2 && /^[가-힣]+$/.test(parts[0]) && parts[0].length <= 4) {
            if (!category) category = parts[0];
            author = parts.slice(1).join(' ');
          } else {
            author = ginfoText;
          }
        }
      }
    }

    posts.push({
      id: `post-${num}`,
      num,
      title,
      url: fullUrl,
      category,
      author,
      date,
      views,
      recommend,
      isNotice: false,
    });
  }

  return posts;
}

// ============================================================
// Comment parsing (mobile DC)
// ============================================================

function parseCommentItem(li: Element, idx: number, isBest: boolean): Comment | null {
  let dcconSrc: string | undefined;
  let text = '';

  // Mobile DC: p.txt contains either text or a DCCon <img>
  const txtEl = li.querySelector('p.txt');
  if (txtEl) {
    const imgInTxt = txtEl.querySelector('img.written_dccon, img[src*="dccon"], img[src*="dcimg"]');
    if (imgInTxt) {
      dcconSrc = imgInTxt.getAttribute('src') ?? undefined;
      text = '[이모티콘]';
    } else {
      text = (txtEl.textContent ?? '').trim();
    }
  }

  if (!text && dcconSrc) text = '[이모티콘]';

  // Fallback: strip known metadata elements and use remaining text
  if (!text) {
    const clone = li.cloneNode(true) as Element;
    clone
      .querySelectorAll(
        '.ginfo-area, button.nick, .nick, .date_time, span.date, .recommend_txt, .info_lay, .user_layer',
      )
      .forEach((e) => e.remove());
    const fallbackText = (clone.textContent ?? '').trim();
    if (fallbackText && !/^\d{2}[.:]\ *\d{2}/.test(fallbackText)) {
      text = fallbackText;
    }
  }

  if (!text) return null;

  // Author
  let author = '익명';
  const nickBtn = li.querySelector('.ginfo-area button.nick, button.nick');
  if (nickBtn) {
    author = (nickBtn.textContent ?? '').trim() || '익명';
  }

  // Nick type badge
  let nickType: 'gonick' | 'nogonick' | 'sub-gonick' | undefined;
  const nickSpan = li.querySelector('.sp-nick');
  if (nickSpan) {
    if (nickSpan.classList.contains('sub-gonick')) nickType = 'sub-gonick';
    else if (nickSpan.classList.contains('gonick')) nickType = 'gonick';
    else if (nickSpan.classList.contains('nogonick')) nickType = 'nogonick';
  }

  const dateEl = li.querySelector('span.date');
  const date = dateEl ? (dateEl.textContent ?? '').trim() : '';

  const recEl = li.querySelector('.recommend_txt');
  const recommend = recEl ? (recEl.textContent ?? '').replace(/[^0-9]/g, '') || '0' : '0';

  const isReply = li.classList.contains('re_li') || li.classList.contains('reply');

  return {
    id: `${isBest ? 'best' : 'cmt'}-${idx}`,
    author,
    text,
    date,
    recommend,
    isBest,
    isReply,
    nickType,
    dcconSrc,
  };
}

function parseComments(doc: Document): Comment[] {
  const comments: Comment[] = [];
  const commentBox = doc.querySelector('#comment_box');
  if (!commentBox) return comments;

  const items = commentBox.querySelectorAll(
    'ul.all-comment-lst > li.comment, ul.all-comment-lst > li[no]',
  );
  items.forEach((li, i) => {
    const c = parseCommentItem(li, i, false);
    if (c) comments.push(c);
  });
  return comments;
}

// ============================================================
// Post detail
// ============================================================

const CONTENT_SELECTORS = [
  '.write_div',
  '.thum-txt',
  '.view_content_wrap',
  '.gallview_contents',
  '#readBody',
];

const REMOVE_INSIDE = [
  '.gallview-tit-wrap',
  '.gallview-head',
  '.view_content_bottom',
  '.bottom_nav',
  '.comment_wrap',
  '.reply_wrap',
  '.ad',
  '.adsbygoogle',
  '.float_ad',
].join(', ');

function extractContentFromDoc(doc: Document, post: Post): string {
  for (const sel of CONTENT_SELECTORS) {
    const el = doc.querySelector(sel) as HTMLElement | null;
    if (!el) continue;
    el.querySelectorAll(REMOVE_INSIDE).forEach((e) => e.remove());
    const textContent = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (textContent.length > 20) {
      return el.innerHTML.trim();
    }
  }
  const safeUrl = post.url.replace(/"/g, '&quot;');
  return `<p style="color:#8b949e">본문을 불러올 수 없습니다. <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--yaar-accent)">DC에서 직접 보기 &uarr;</a></p>`;
}

/**
 * Fetch post body and comments in a single browser load.
 *
 * DC injects comments via an AJAX call after the initial page render.
 * We wait for the `#comment_box li.comment` selector to appear (up to 4 s)
 * so that both the post body and the AJAX-loaded comments are captured in
 * one HTML snapshot. This is simpler and more reliable than calling the
 * comment AJAX endpoint separately, because that endpoint requires a valid
 * CSRF token and Referer header that change across sessions.
 */
export async function fetchPostDetail(
  post: Post,
  tabId?: string,
): Promise<{ content: string; comments: Comment[] }> {
  tabId ??= postTabId(post.num);
  await openOrNavigate(post.url, tabId, {
    visible: false,
    mobile: true,
  });

  // Wait for AJAX-loaded comments (post body is in the initial HTML).
  // No need for networkidle — this single waitFor covers the comment AJAX.
  await web
    .waitFor({
      selector: '#comment_box li.comment',
      timeout: 4000,
      browserId: tabId,
    })
    .catch(() => {});

  const rawHtml = (await web.html({ browserId: tabId })) as { ok: boolean; data?: string };
  const html = rawHtml?.data ?? '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, noscript, style').forEach((e) => e.remove());

  const comments = parseComments(doc);
  const content = extractContentFromDoc(doc, post);

  return { content, comments };
}

/**
 * Fetch top N posts by recommend count for AI analysis.
 * Staggers requests 1 s apart to avoid rate limiting.
 */
export async function fetchTopPostsForAnalysis(
  allPosts: Post[],
  count = 5,
): Promise<Array<{ post: Post; text: string }>> {
  const candidates = [...allPosts]
    .sort((a, b) => (parseInt(b.recommend) || 0) - (parseInt(a.recommend) || 0))
    .slice(0, count);

  const results = await Promise.all(
    candidates.map(
      (post, i) =>
        new Promise<{ post: Post; text: string }>((resolve) => {
          setTimeout(async () => {
            try {
              const tabId = `analysis-${i % 3}`;
              const rawHtml = await browseUrl(post.url, tabId, true);
              const parser = new DOMParser();
              const doc = parser.parseFromString(rawHtml, 'text/html');
              doc.querySelectorAll('script, noscript, style').forEach((e) => e.remove());

              const el =
                doc.querySelector('.write_div') ??
                doc.querySelector('.thum-txt') ??
                doc.querySelector('.view_content_wrap');

              const text = el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
              resolve({ post, text: text.slice(0, 600) });
            } catch {
              resolve({ post, text: '' });
            }
          }, i * 1000);
        }),
    ),
  );

  return results;
}
