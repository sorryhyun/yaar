/**
 * fetcher.ts — DCinside comic gallery scraper
 *
 * List page: desktop gall.dcinside.com (table-based HTML)
 * Detail page: mobile m.dcinside.com (for content + comments)
 * Uses yaar-web headless browser to get HTML, then parses client-side with DOMParser.
 */
import type { Post, Comment, TabMode } from './types';
import * as web from '@bundled/yaar-web';
import { openOrNavigate, MAIN_TAB, POST_TAB } from './browser';

const GALLERY_ID = 'comic_new6';
const GALLERY_LIST_BASE = 'https://gall.dcinside.com/board/lists/';
const MOBILE_POST_BASE = `https://m.dcinside.com/board/${GALLERY_ID}`;

function buildListUrl(mode: TabMode, page: number): string {
  const params = new URLSearchParams();
  params.set('id', GALLERY_ID);
  if (mode === 'recommend') params.set('exception_mode', 'recommend');
  if (page > 1) params.set('page', String(page));
  return `${GALLERY_LIST_BASE}?${params.toString()}`;
}

async function browseUrl(url: string, tabId: string, mobile = true): Promise<string> {
  await openOrNavigate(url, tabId, { visible: false, mobile });
  const result = (await web.html({ browserId: tabId })) as { ok: boolean; data?: string };
  return result?.data ?? '';
}

// ============================================================
// Post list (desktop HTML — table-based)
// ============================================================

export async function fetchPosts(mode: TabMode, page = 1): Promise<Post[]> {
  const url = buildListUrl(mode, page);
  const html = await browseUrl(url, MAIN_TAB, false); // desktop mode
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Desktop DCinside uses a table with tr.ub-content rows
  let rows = Array.from(doc.querySelectorAll('tr.ub-content.us-post'));
  if (rows.length === 0) {
    // Fallback: try any tr.ub-content
    rows = Array.from(doc.querySelectorAll('tr.ub-content'));
  }

  const posts: Post[] = [];

  for (const tr of rows) {
    // Post number from td.gall_num
    const numEl = tr.querySelector('td.gall_num');
    const num = numEl ? (numEl.textContent ?? '').trim() : '';
    if (!num || !/^\d+$/.test(num)) continue; // Skip notices, ads, etc.

    // Title from td.gall_tit
    const titCell = tr.querySelector('td.gall_tit');
    if (!titCell) continue;
    const titleLink = titCell.querySelector('a:not(.reply_numbox)') as HTMLAnchorElement | null;
    if (!titleLink) continue;

    // Extract title text (excluding icon elements)
    const titleClone = titleLink.cloneNode(true) as Element;
    titleClone.querySelectorAll('em, .icon_img, .icon_txt').forEach((el) => el.remove());
    let titleRaw = (titleClone.textContent ?? '').trim();
    if (!titleRaw) titleRaw = '(제목 없음)';

    // Category from [bracket] prefix
    let category: string | undefined;
    const catMatch = titleRaw.match(/^\[([^\]]+)\]/);
    if (catMatch) {
      category = catMatch[1].trim();
      titleRaw = titleRaw.slice(catMatch[0].length).trim();
    }
    const title = titleRaw;

    // Extract post number from href and build mobile URL for detail view
    const href = titleLink.getAttribute('href') ?? '';
    const noMatch = href.match(/[?&]no=(\d+)/);
    const postNum = noMatch ? noMatch[1] : num;
    const fullUrl = `${MOBILE_POST_BASE}/${postNum}`;

    // Comment count from reply_numbox
    const replyEl = titCell.querySelector('.reply_numbox');
    let comments = '0';
    if (replyEl) {
      const m = (replyEl.textContent ?? '').match(/(\d+)/);
      if (m) comments = m[1];
    }

    // Has image
    const hasImage = !!titCell.querySelector('.icon_pic, .icon_img, .icon_movie');

    // Writer from td.gall_writer
    const writerCell = tr.querySelector('td.gall_writer');
    let author = '익명';
    if (writerCell) {
      const dataNick = writerCell.getAttribute('data-nick') ?? '';
      if (dataNick) {
        author = dataNick;
      } else {
        const nickEl = writerCell.querySelector('.nickname em, .nickname, .nick');
        if (nickEl) author = (nickEl.textContent ?? '').trim() || '익명';
      }
    }

    // Date from td.gall_date
    const dateCell = tr.querySelector('td.gall_date');
    const date = dateCell
      ? (dateCell.getAttribute('title') ?? dateCell.textContent ?? '').trim()
      : '';

    // Views from td.gall_count
    const viewsCell = tr.querySelector('td.gall_count');
    const views = viewsCell ? (viewsCell.textContent ?? '').trim() : '0';

    // Recommend from td.gall_recommend
    const recCell = tr.querySelector('td.gall_recommend');
    const recommend = recCell ? (recCell.textContent ?? '').trim() : '0';

    posts.push({
      id: `post-${postNum}`,
      num: postNum,
      title,
      url: fullUrl,
      category,
      author,
      date,
      views,
      recommend,
      comments,
      isNotice: false,
      hasImage,
    });
  }

  return posts;
}

// ============================================================
// Comment parsing (mobile HTML)
// ============================================================

function parseCommentItem(li: Element, idx: number): Comment | null {
  let dcconSrc: string | undefined;
  let text = '';

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

  if (!text) {
    const clone = li.cloneNode(true) as Element;
    clone.querySelectorAll('.ginfo-area, button.nick, .nick, .date_time, span.date, .recommend_txt, .info_lay, .user_layer').forEach((e) => e.remove());
    const fallbackText = (clone.textContent ?? '').trim();
    if (fallbackText && !/^\d{2}[.:] *\d{2}/.test(fallbackText)) text = fallbackText;
  }

  if (!text) return null;

  let author = '익명';
  const nickBtn = li.querySelector('.ginfo-area button.nick, button.nick');
  if (nickBtn) author = (nickBtn.textContent ?? '').trim() || '익명';

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
  const isBest = li.classList.contains('best');

  return {
    id: `cmt-${idx}`,
    author, text, date, recommend, isBest, isReply, nickType, dcconSrc,
  };
}

function parseComments(doc: Document): Comment[] {
  const comments: Comment[] = [];
  const commentBox = doc.querySelector('#comment_box');
  if (!commentBox) return comments;
  const items = commentBox.querySelectorAll('ul.all-comment-lst > li.comment, ul.all-comment-lst > li[no]');
  items.forEach((li, i) => {
    const c = parseCommentItem(li, i);
    if (c) comments.push(c);
  });
  return comments;
}

// ============================================================
// Post detail (mobile HTML)
// ============================================================

const CONTENT_SELECTORS = ['.write_div', '.thum-txt', '.view_content_wrap', '.gallview_contents', '#readBody'];
const REMOVE_INSIDE = [
  '.gallview-tit-wrap', '.gallview-head', '.view_content_bottom',
  '.bottom_nav', '.comment_wrap', '.reply_wrap', '.ad', '.adsbygoogle', '.float_ad',
].join(', ');

function fixImages(el: HTMLElement): void {
  el.querySelectorAll('img').forEach((img) => {
    // Fix lazy-loaded images
    const dataSrc = img.getAttribute('data-src') ?? img.getAttribute('data-lazy-src');
    if (dataSrc && !img.src) img.src = dataSrc;
    img.removeAttribute('loading');
    img.style.maxWidth = '100%';
  });
}

function extractContentFromDoc(doc: Document, post: Post): string {
  for (const sel of CONTENT_SELECTORS) {
    const el = doc.querySelector(sel) as HTMLElement | null;
    if (!el) continue;
    el.querySelectorAll(REMOVE_INSIDE).forEach((e) => e.remove());
    fixImages(el);
    const textContent = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (textContent.length > 20) return el.innerHTML.trim();
  }
  const safeUrl = post.url.replace(/"/g, '&quot;');
  return `<p style="color:#8b949e">본문을 불러올 수 없습니다. <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--yaar-accent)">DC에서 직접 보기 &uarr;</a></p>`;
}

export async function fetchPostDetail(
  post: Post,
): Promise<{ content: string; comments: Comment[] }> {
  await openOrNavigate(post.url, POST_TAB, { visible: false, mobile: true });

  await (web as any).waitFor?.({
    selector: '#comment_box li.comment',
    timeout: 4000,
    browserId: POST_TAB,
  }).catch(() => {});

  const rawHtml = (await web.html({ browserId: POST_TAB })) as { ok: boolean; data?: string };
  const html = rawHtml?.data ?? '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, noscript, style').forEach((e) => e.remove());

  const comments = parseComments(doc);
  const content = extractContentFromDoc(doc, post);

  return { content, comments };
}
