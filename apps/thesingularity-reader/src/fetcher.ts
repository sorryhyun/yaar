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
import type { Post, Comment, SearchType } from './types';
import * as web from '@bundled/yaar-web';
import { httpFetch } from '@bundled/yaar';
import { openOrNavigate, MAIN_TAB, POST_TAB } from './browser';
import { extractRealImageUrl, LAZY_IMAGE_ATTRS } from './helpers';

const GALLERY_ID = 'thesingularity';
const GALLERY_URL = `https://m.dcinside.com/board/${GALLERY_ID}`;

// iOS Safari UA — DC misclassifies our previous Android/Chrome UA as
// WebP-unsupported and swaps image URLs for a static m_webp.png notice. An iOS
// Safari UA is treated as WebP-capable, so DC returns the real viewimage.php
// URLs. Fixed spoofed UA sent server-side; independent of the host OS.
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

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

/** Parse a mobile DC gallery list page (or search result page) into Post[]. */
function parsePostList(html: string): Post[] {
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
    let categoryFromFlair = '';

    const titleEl = aEl.querySelector('.gall-tit-txt');
    if (titleEl) {
      // Extract flair/category badge BEFORE stripping.
      // Mobile DC renders flairs as em.sp-flair, .gall-flair, or similar inside the title element.
      const flairEl = titleEl.querySelector('em.sp-flair, .gall-flair, [class*="flair"]');
      if (flairEl) {
        const ft = (flairEl.textContent ?? '').trim();
        if (ft) categoryFromFlair = ft;
      }

      const clone = titleEl.cloneNode(true) as Element;
      clone.querySelectorAll(META_SELECTORS).forEach((el) => el.remove());
      // Remove flair elements from the clone so they don't pollute the title text.
      clone.querySelectorAll('em.sp-flair, .gall-flair, [class*="flair"]').forEach((el) => el.remove());
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
    let category: string | undefined = categoryFromTitle || categoryFromFlair || undefined;

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
          // Allow emoji-prefixed categories like 📪정보 or 📢정보 (JS length up to 8),
          // and plain Korean categories like 일반. Must contain Korean and not start with digit.
          if (parts.length >= 2 && /[가-힣]/.test(parts[0]) && !/^\d/.test(parts[0]) && parts[0].length <= 8) {
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

export async function fetchPosts(page = 1): Promise<Post[]> {
  const url = page > 1 ? `${GALLERY_URL}?page=${page}` : GALLERY_URL;
  const html = await browseUrl(url, MAIN_TAB);
  return parsePostList(html);
}

/**
 * Search within the gallery using mobile DC's in-board search.
 * URL pattern: m.dcinside.com/board/{id}?s_type={type}&serval={keyword}&page={n}
 *   s_type (mobile values — NOT the desktop search_subject_memo form):
 *     subject_m(제목+내용) | subject(제목) | memo(내용) | name(글쓴이) | comment(댓글)
 * NOTE: passing the desktop values (search_subject_memo, …) makes DC silently
 * ignore the filter and return the full gallery list. The mobile search form
 * (m.dcinside.com) uses these short values via input name="serval".
 * Results use the same `ul.gall-detail-lst` markup as the normal list, so we
 * reuse parsePostList().
 */
export async function fetchSearchResults(
  keyword: string,
  sType: SearchType = 'subject_m',
  page = 1,
): Promise<Post[]> {
  const kw = keyword.trim();
  if (!kw) return [];
  const params = new URLSearchParams({ s_type: sType, serval: kw });
  if (page > 1) params.set('page', String(page));
  const url = `${GALLERY_URL}?${params.toString()}`;
  // networkidle: search results render after an XHR on some responses.
  const html = await browseUrl(url, MAIN_TAB, true);
  return parsePostList(html);
}

// ============================================================
// Comment parsing (mobile DC)
// ============================================================

// A DCCon (디시콘) sticker <img> inside a comment. Mobile DC lazy-loads these:
// `src` is often a loading placeholder while the real URL sits in
// data-original/data-src — so we must match on class and lazy attrs, not just src.
const DCCON_IMG_SELECTOR =
  'img.written_dccon, img.dccon, img[class*="dccon"], img[src*="dccon"], img[src*="dcimg"], img[data-original*="dccon"], img[data-src*="dccon"], img[data-original*="dcimg"], img[data-src*="dcimg"]';

/** Resolve a DCCon <img>'s real URL, accounting for lazy-load placeholders. */
function resolveDcconUrl(img: HTMLImageElement): string | undefined {
  const real = extractRealImageUrl(img);
  if (real) return real;
  for (const a of ['data-original', 'data-src', 'src']) {
    const v = (img.getAttribute(a) ?? '').trim();
    if (v && !v.startsWith('data:')) return v;
  }
  return undefined;
}

function parseCommentItem(li: Element, idx: number, isBest: boolean): Comment | null {
  let dcconSrc: string | undefined;
  let text = '';

  // Mobile DC: p.txt contains either text or a DCCon <img>.
  const txtEl = li.querySelector('p.txt');
  if (txtEl) {
    const imgInTxt = txtEl.querySelector(DCCON_IMG_SELECTOR) as HTMLImageElement | null;
    if (imgInTxt) {
      dcconSrc = resolveDcconUrl(imgInTxt);
      text = '[디시콘]';
    } else {
      text = (txtEl.textContent ?? '').trim();
    }
  }

  // A DCCon may live outside p.txt (or p.txt may be absent for image-only
  // comments) — scan the whole item so sticker comments are never dropped.
  if (!dcconSrc) {
    const anyDccon = li.querySelector(DCCON_IMG_SELECTOR) as HTMLImageElement | null;
    if (anyDccon) {
      dcconSrc = resolveDcconUrl(anyDccon);
      if (!text) text = '[디시콘]';
    }
  }

  if (!text && dcconSrc) text = '[디시콘]';

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

// Selectors are tried in order; first one that yields meaningful content wins.
// Mobile DC has shifted markup over the years; we keep the legacy desktop
// selectors plus newer mobile-specific ones to be resilient.
const CONTENT_SELECTORS = [
  '.thum-txtin',
  '.thum-txt',
  '.write_div',
  '.view_content_wrap',
  '.gallview_contents',
  '.gallview-content',
  '.gall-detail-content',
  '.gall-content',
  '#readBody',
  '.con-body',
  '[class*="thum-txt"]',
  '[class*="gallview"][class*="content"]',
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
  '.detail-ad',
  '.adWrap',
  '.dc-banner',
].join(', ');

/**
 * Last-ditch fallback: scan all <div>/<section> nodes outside of comments/header,
 * pick the one with the most text content or images. Mobile DC sometimes ships
 * bespoke markup we don't have a selector for; this rescues the body in that case.
 */
// Phrases that ONLY appear in DC's page chrome (settings dropdown, header menu,
// external-link warning layer). If a fallback candidate's text contains any of
// these it is page chrome, not the post body — reject it. This is what caused
// empty/title-only posts to render the settings menu as the body.
const CHROME_KEYWORDS = [
  '차단 설정',
  '머리말',
  '꼬리말',
  '이용자 메모',
  '자동 짤방',
  'AI 이미지 간편 등록',
  '외부 링크 이동',
  '신뢰할 수 있는 사이트',
];

// Selectors whose presence INSIDE a candidate marks it as a page wrapper that
// merely contains the body (plus header/nav/comments) rather than the body
// itself. The greedy text-length score would otherwise always favour these.
const CHROME_WRAPPER_SELECTORS =
  '#comment_box, .comment_wrap, .reply_wrap, header, nav, footer, .gnb_wrap, .h_top, .top_wrap, .gallview-tit-wrap, .gallview-head';

function findContentFallback(doc: Document): HTMLElement | null {
  const candidates = Array.from(doc.querySelectorAll('div, section, article')) as HTMLElement[];
  let best: HTMLElement | null = null;
  let bestScore = 0;

  for (const el of candidates) {
    // Skip if inside excluded regions
    if (el.closest('#comment_box, .comment_wrap, .reply_wrap, header, nav, footer, .gallview-tit-wrap, .gallview-head, .gnb_wrap, .h_top, .top_wrap')) continue;
    // Skip if it itself is excluded
    const cls = el.className || '';
    if (typeof cls === 'string' && /(comment|reply|gnb|footer|header|banner|adsbygoogle|aside|setting|layer|popup|lnb|menu|search)/i.test(cls)) continue;
    // Skip page-chrome WRAPPERS: a real post body never contains the site
    // header/nav/gnb/comment region. Such a candidate is an outer wrapper.
    if (el.querySelector(CHROME_WRAPPER_SELECTORS)) continue;

    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    // Reject containers dominated by settings/menu chrome keywords.
    if (CHROME_KEYWORDS.some((k) => text.includes(k))) continue;

    const imgCount = el.querySelectorAll('img').length;
    const score = text.length + imgCount * 50;
    if (score > bestScore && (text.length > 30 || imgCount > 0)) {
      // Prefer the deepest container that contains all the content (avoid <body>)
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function extractContentFromDoc(doc: Document, post: Post): string {
  // 1. Try the known body containers in order. The FIRST one that exists is the
  //    standard mobile-DC body container; remember it even when it's (near-)
  //    empty so we can tell "empty post" apart from "unknown markup".
  let knownEmptyEl: HTMLElement | null = null;
  for (const sel of CONTENT_SELECTORS) {
    const el = doc.querySelector(sel) as HTMLElement | null;
    if (!el) continue;
    el.querySelectorAll(REMOVE_INSIDE).forEach((e) => e.remove());
    // Trim + collapse whitespace so whitespace-only counts as empty. Any
    // remaining non-whitespace character means this is a real (if short) body —
    // e.g. 'ㅇㅇ', a one-liner, an emoji, or a short URL.
    const textContent = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    // Treat embedded media (images, video, iframes) as real content too — a
    // post can be media-only with no text.
    const hasMedia = el.querySelector('img, video, iframe, embed') !== null;
    if (textContent.length > 0 || hasMedia) {
      return el.innerHTML.trim();
    }
    // Container exists but is truly empty (no text, no media). Remember it so we
    // can show '(본문 없음)' rather than scraping page chrome.
    if (!knownEmptyEl) knownEmptyEl = el;
  }

  // 2. A standard body container existed but is empty — this is a genuinely
  //    body-less post (e.g. a title-only question). Do NOT fall through to the
  //    heuristic scan, which would scrape the page's settings/nav chrome.
  if (knownEmptyEl) {
    return '<p style="color:var(--yaar-text-muted)">(본문 없음)</p>';
  }

  // 3. No known container matched at all — the markup is unfamiliar. Resort to
  //    the heuristic scan, which now rejects page chrome (see findContentFallback).
  const fallback = findContentFallback(doc);
  if (fallback) {
    fallback.querySelectorAll(REMOVE_INSIDE).forEach((e) => e.remove());
    return fallback.innerHTML.trim();
  }

  const safeUrl = post.url.replace(/"/g, '&quot;');
  return `<p style="color:var(--yaar-text-muted)">본문을 불러올 수 없습니다. <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--yaar-accent)">DC에서 직접 보기 &uarr;</a></p>`;
}

/** Referer DC's hotlink protection accepts (mobile gallery origin). */
const DC_REFERER = 'https://m.dcinside.com/';

/** Read a Blob as a `data:` URI. Resolves to null rather than throwing. */
function blobToDataUri(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * Fetch a single image via the server-side HTTP proxy and return it as a
 * base64 `data:` URI.
 *
 * Why proxy instead of loading the URL directly in an <img>?
 *  - In-browser fetch() is CORS-blocked for DC's cross-origin image hosts
 *    (dcimg*.dcinside.*) — they send no ACAO header.
 *  - Plain remote <img> loads are unreliable due to Referer hotlink protection.
 * The proxy is NOT subject to CORS and lets us send a DC Referer header so
 * hotlink protection allows the request.
 *
 * Returns null on any failure; the caller keeps the original src.
 */
async function fetchImageAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await httpFetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': MOBILE_UA,
        Referer: DC_REFERER,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });
    if (!res.ok) return null;

    // A Blob already carries the response's content type, so the mime no longer
    // has to be recovered from a header map by hand. DC's image hosts sometimes
    // answer with a generic or empty type, so fall back to jpeg as before.
    const raw = await res.blob();
    const blob = raw.type.startsWith('image/') ? raw : new Blob([raw], { type: 'image/jpeg' });
    return await blobToDataUri(blob);
  } catch {
    return null;
  }
}

/**
 * Inline all remote <img> sources in a post-body HTML string as base64 data
 * URIs by proxying them through httpFetch. This is the reliable image path —
 * see fetchImageAsDataUri for why direct/in-browser loading fails. Images that
 * are already inlined (data:) or have no usable URL are left untouched.
 */
export async function inlineRemoteImages(htmlStr: string): Promise<string> {
  if (!htmlStr || !htmlStr.includes('<img')) return htmlStr;
  const doc = new DOMParser().parseFromString(
    `<div id="__inline_root">${htmlStr}</div>`,
    'text/html',
  );
  const root = doc.getElementById('__inline_root');
  if (!root) return htmlStr;

  const imgs = Array.from(root.querySelectorAll('img')) as HTMLImageElement[];
  if (imgs.length === 0) return htmlStr;

  await Promise.allSettled(
    imgs.map(async (img) => {
      const url = extractRealImageUrl(img);
      if (!url) return; // placeholder/blank — processImages will drop it
      if (url.startsWith('data:')) {
        img.setAttribute('src', url);
        return;
      }
      const dataUri = await fetchImageAsDataUri(url);
      // Promote the resolved URL into src either way; if proxying succeeded use
      // the data URI, otherwise leave the real URL so the no-referrer <img>
      // load can still try it.
      img.setAttribute('src', dataUri ?? url);
      if (dataUri) {
        for (const a of LAZY_IMAGE_ATTRS) img.removeAttribute(a);
        img.removeAttribute('data-srcset');
        img.removeAttribute('srcset');
        img.removeAttribute('class');
      }
    }),
  );

  return root.innerHTML;
}

/** Parse a raw HTML document string and extract the post body markup. */
function extractBodyFromHtml(html: string, post: Post): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, noscript, style').forEach((e) => e.remove());
  return extractContentFromDoc(doc, post);
}

/** Shared headers for the proxied (httpFetch) mobile DC fetches. */
const DC_HTTP_HEADERS = {
  'User-Agent': MOBILE_UA,
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'ko-KR,ko;q=0.9',
} as const;

/**
 * Fetch a post’s body over plain HTTP (via the server-side proxy) and
 * inline its images.
 *
 * This is the primary body path. The mobile DC post page renders the body in
 * the initial HTML response, so a proxied GET returns it in ~300–800 ms with no
 * browser tab and no CORS. Remote images are inlined as base64 data URIs via the
 * server proxy (with a DC Referer) — see fetchImageAsDataUri. Comments are
 * AJAX-injected after render and are therefore NOT included here; they come from
 * fetchPostComments (the browser read path).
 *
 * Returns null when the body can't be fetched/parsed so the caller can fall
 * back to the browser snapshot.
 */
export async function fetchPostBody(post: Post): Promise<string | null> {
  try {
    const res = await httpFetch(post.url, {
      method: 'GET',
      headers: { ...DC_HTTP_HEADERS },
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html) return null;
    const content = extractBodyFromHtml(html, post);
    // If we hit the "불러올 수 없습니다" fallback, treat as no result so the caller
    // falls back to the browser snapshot instead of flashing the error message.
    if (content.includes('본문을 불러올 수 없습니다')) return null;
    return await inlineRemoteImages(content);
  } catch {
    return null;
  }
}

/**
 * Browser read path — the ONLY part of reading that still needs a real browser.
 *
 * DC injects comments via an AJAX call after the initial page render, so a plain
 * HTTP GET never sees them. We open a headless tab, wait for the comment DOM to
 * appear, and scrape it. We also return the raw (non-inlined) body markup from
 * the same snapshot so callers can use it as a fallback when the HTTP body path
 * (fetchPostBody) fails — no extra load required.
 *
 * Image inlining is intentionally NOT done here: it is handled server-side by
 * fetchPostBody / inlineRemoteImages, which has no CORS or referer constraints.
 */
export async function fetchPostComments(
  post: Post,
  tabId?: string,
): Promise<{ comments: Comment[]; bodyHtmlRaw: string }> {
  tabId ??= POST_TAB;
  await openOrNavigate(post.url, tabId, { visible: false, mobile: true });

  // Wait for AJAX-loaded comments. A single waitFor covers the comment AJAX;
  // no networkidle needed (the body is already in the initial HTML).
  await web
    .waitFor({ selector: '#comment_box li.comment', timeout: 3500, browserId: tabId })
    .catch(() => {});

  const rawHtml = (await web.html({ browserId: tabId })) as { ok: boolean; data?: string };
  const html = rawHtml?.data ?? '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, noscript, style').forEach((e) => e.remove());

  const comments = parseComments(doc);
  // Inline DCCon sticker images as base64 data URIs via the server proxy (with a
  // DC Referer) so they display reliably — comment images face the same CORS /
  // hotlink protection as body images and aren't inlined anywhere else.
  await Promise.allSettled(
    comments.map(async (c) => {
      if (c.dcconSrc && !c.dcconSrc.startsWith('data:')) {
        const inlined = await fetchImageAsDataUri(c.dcconSrc);
        if (inlined) c.dcconSrc = inlined;
      }
    }),
  );

  return { comments, bodyHtmlRaw: extractContentFromDoc(doc, post) };
}

/**
 * Fetch a post's body and comments together.
 *
 * Body comes from the HTTP path (fetchPostBody); comments from the browser
 * (fetchPostComments). Both run concurrently. If the HTTP body fails, the body
 * markup captured by the browser snapshot is inlined and used as a fallback so
 * one bad path never blanks the post.
 */
export async function fetchPostDetail(
  post: Post,
  tabId?: string,
): Promise<{ content: string; comments: Comment[] }> {
  const [httpBody, browser] = await Promise.all([
    fetchPostBody(post),
    fetchPostComments(post, tabId).catch(() => ({
      comments: [] as Comment[],
      bodyHtmlRaw: '',
    })),
  ]);

  let content = httpBody;
  if (!content && browser.bodyHtmlRaw) {
    content = await inlineRemoteImages(browser.bodyHtmlRaw);
  }
  if (!content) {
    const safeUrl = post.url.replace(/"/g, '&quot;');
    content = `<p style="color:var(--yaar-text-muted)">본문을 불러올 수 없습니다. <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--yaar-accent)">DC에서 직접 보기 &uarr;</a></p>`;
  }

  return { content, comments: browser.comments };
}

/**
 * Fetch a single post's body as plain text over HTTP (no browser). Used for AI
 * analysis where only the text matters.
 */
async function fetchPostText(post: Post): Promise<string> {
  try {
    const res = await httpFetch(post.url, {
      method: 'GET',
      headers: { ...DC_HTTP_HEADERS },
    });
    if (!res.ok) return '';
    const html = await res.text();
    if (!html) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, noscript, style').forEach((e) => e.remove());
    const el =
      doc.querySelector('.write_div') ??
      doc.querySelector('.thum-txtin') ??
      doc.querySelector('.thum-txt') ??
      doc.querySelector('.view_content_wrap');
    const text = el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
    return text.slice(0, 600);
  } catch {
    return '';
  }
}

/**
 * Fetch top N posts by recommend count for AI analysis.
 *
 * HTTP fetches go through the server proxy (no shared browser tab to serialize
 * on), so we run them concurrently — no 1 s stagger needed.
 */
export async function fetchTopPostsForAnalysis(
  allPosts: Post[],
  count = 5,
): Promise<Array<{ post: Post; text: string }>> {
  const candidates = [...allPosts]
    .sort((a, b) => (parseInt(b.recommend) || 0) - (parseInt(a.recommend) || 0))
    .slice(0, count);

  return Promise.all(candidates.map(async (post) => ({ post, text: await fetchPostText(post) })));
}
