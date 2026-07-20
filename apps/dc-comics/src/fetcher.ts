/**
 * fetcher.ts — DCinside comic gallery scraper
 *
 * List page: desktop gall.dcinside.com (table-based HTML)
 * Detail page: mobile m.dcinside.com (for content + comments)
 * Uses yaar-web headless browser to get HTML, then parses client-side with DOMParser.
 */
import type { Post, Comment, TabMode, ImgComment, ImgCommentMap } from './types';
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
  // The mobile comment container is #comment_box / ul.all-comment-lst -- neither
  // matched the old .comment_wrap/.reply_wrap pair, so the whole comment thread
  // was being pulled into the body HTML and rendered twice (once inline, once in
  // CommentSection), dragging every comment dccon through the image pipeline.
  '#comment_box', '.all-comment-lst', '.comment-add-box', '.cmt_write_box',
  // Per-image comment (짤방댓글) widgets. DC ships an empty .img-comment shell
  // next to every image and fills it by AJAX on tap, so scraped HTML carries
  // only the chrome -- "댓글[16]새로고침 댓글닫기 댓글 위로" was rendering as junk
  // text in the body. The real comments are fetched separately (see
  // fetchImageComments); the count and fileno are lifted off the <img> itself
  // in collectImageComments BEFORE this strip runs.
  '.img-comment', '.tip_box2',
].join(', ');

/** Attribute names carrying per-image comment metadata through to the viewer. */
export const IMGC_FILENO_ATTR = 'data-imgc-fileno';
export const IMGC_COUNT_ATTR = 'data-imgc-count';

/**
 * Lift each image's comment count off the .img-comment widget and stamp it onto
 * the <img> itself, so the viewer can label the toggle ("댓글 [16]") immediately
 * without any network call -- and so images with zero comments can be told
 * apart and get no toggle at all.
 *
 * MUST run before REMOVE_INSIDE strips .img-comment, which is where the count
 * lives. The comment bodies are not here (mobile ships the shell empty); they
 * are fetched later by fetchImageComments and matched on fileno.
 */
function stampImageCommentCounts(el: HTMLElement): void {
  const counts = new Map<string, string>();
  el.querySelectorAll('div.img-comment[id^="img_comment_div"]').forEach((d) => {
    const fileno = (d.getAttribute('id') ?? '').replace('img_comment_div', '').trim();
    if (!fileno) return;
    const totalEl = d.querySelector('.img_comment_total');
    const n = totalEl ? (totalEl.textContent ?? '').replace(/[^0-9]/g, '') : '';
    if (n) counts.set(fileno, n);
  });

  el.querySelectorAll('img[data-fileno]').forEach((img) => {
    const fileno = (img.getAttribute('data-fileno') ?? '').trim();
    if (!fileno) return;
    // Stamp only when DC actually gave us a count, i.e. when it server-rendered
    // the .img-comment shell for this image.
    //
    // DC renders those shells for only the first few images of a post and loads
    // the rest on demand; scrolling the page does NOT bring them in (verified:
    // a full scroll to the bottom leaves the shell count unchanged). Keying off
    // DC's data-comment="1" flag instead would mark images we cannot fetch
    // threads for, producing toggles that open onto nothing. Gating on the count
    // keeps the toggle set exactly equal to the set we can populate, and adapts
    // automatically if DC serves more shells.
    const declared = (img.getAttribute('data-comment') ?? '').trim();
    if (declared === '0') return;
    const n = counts.get(fileno);
    if (!n) return;
    img.setAttribute(IMGC_FILENO_ATTR, fileno);
    img.setAttribute(IMGC_COUNT_ATTR, n);
  });
}

function extractContentFromDoc(doc: Document, post: Post): string {
  for (const sel of CONTENT_SELECTORS) {
    const el = doc.querySelector(sel) as HTMLElement | null;
    if (!el) continue;
    stampImageCommentCounts(el);
    el.querySelectorAll(REMOVE_INSIDE).forEach((e) => e.remove());
    // Lazy-load resolution + progressive deferral happens in DetailPanel via
    // processImages() on the returned HTML; no need to touch <img> here.
    // Accept on text OR on images. A comic-gallery post is almost entirely
    // images with little or no caption text, so a text-length-only guard
    // rejects the correct element and falls through to the "cannot load"
    // message -- the body is there, it just has nothing to say in words.
    const textContent = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const hasImage = !!el.querySelector('img');
    if (textContent.length > 20 || hasImage) return el.innerHTML.trim();
  }
  const safeUrl = post.url.replace(/"/g, '&quot;');
  return `<p style="color:var(--yaar-text-muted)">본문을 불러올 수 없습니다. <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--yaar-accent)">DC에서 직접 보기 &uarr;</a></p>`;
}

// ============================================================
// Per-image comments (짤방댓글)
// ============================================================

/**
 * Fetch every per-image comment thread for a post in ONE page load.
 *
 * Why the desktop page: the mobile view (used for the body) ships each
 * .img-comment container empty and fills it by AJAX on tap, so scraping it
 * yields nothing. The desktop view renders the threads inline in the HTML --
 * author, nick type and date included -- so a single fetch gets everything.
 *
 * Why the scroll: desktop only server-renders the first few images' threads and
 * lazy-loads the rest as they enter the viewport. Scrolling the headless page to
 * the bottom triggers all of them, after which one html() read has the lot.
 * Measured against a post with 8 images: 3 threads before the scroll, all 8
 * after, with every parsed count matching DC's own displayed total exactly.
 *
 * Reuses POST_TAB: the body HTML has already been captured by the time this
 * runs, so navigating that tab away is harmless. A dedicated fresh tab was
 * tried first and did not work -- DC served the desktop page without any
 * .img-comment markup at all, so the widgets depend on tab state established by
 * the preceding mobile post visit.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseImgCommentItem(li: Element, idx: number): ImgComment | null {
  const txtEl = li.querySelector('p.txt');
  const text = txtEl ? (txtEl.textContent ?? '').trim() : '';
  if (!text) return null;

  const nickBtn = li.querySelector('button.nick');
  let author = '익명';
  if (nickBtn) {
    // The nickname button can carry a <span class="nicknum"> badge; drop it so
    // "만갤러14" doesn't render as the author's name.
    const clone = nickBtn.cloneNode(true) as Element;
    clone.querySelectorAll('.nicknum').forEach((e) => e.remove());
    author = (clone.textContent ?? '').trim() || '익명';
  }

  let nickType: 'gonick' | 'nogonick' | 'sub-gonick' | undefined;
  const nickSpan = li.querySelector('.sp-nick');
  if (nickSpan) {
    if (nickSpan.classList.contains('sub-gonick')) nickType = 'sub-gonick';
    else if (nickSpan.classList.contains('gonick')) nickType = 'gonick';
    else if (nickSpan.classList.contains('nogonick')) nickType = 'nogonick';
  }

  const dateEl = li.querySelector('span.date');
  const date = dateEl ? (dateEl.textContent ?? '').trim() : '';

  return { id: li.getAttribute('no') ?? `imgc-${idx}`, author, text, date, nickType };
}

export async function fetchImageComments(post: Post): Promise<ImgCommentMap> {
  const url = `${GALLERY_LIST_BASE.replace('/board/lists/', '/board/view/')}?id=${GALLERY_ID}&no=${post.num}`;
  await openOrNavigate(url, POST_TAB, { visible: false, mobile: false });

  // Don't start scrolling until the first thread is in the DOM, otherwise the
  // scroll pass can run against a page that hasn't rendered any widgets yet.
  await (web as any).waitFor?.({
    selector: 'div.img-comment',
    timeout: 6000,
    browserId: POST_TAB,
  }).catch(() => {});

  // Walk the page to the bottom so DC lazy-loads every image's thread.
  //
  // Deliberately many short evaluate() calls rather than one long one: a single
  // in-page scroll loop with its own sleeps blew the CDP Runtime.evaluate
  // budget ("did not respond within 15000ms") and the whole pass was silently
  // lost to the .catch(), leaving only the server-rendered threads. Each call
  // here returns immediately and the waiting happens on this side instead.
  // Step down by roughly a viewport at a time rather than jumping to fractions
  // of the page height: DC renders each thread when its image enters the
  // viewport, and large jumps skip past images without ever triggering that.
  const MAX_SCROLL_STEPS = 60;
  for (let i = 0; i < MAX_SCROLL_STEPS; i++) {
    const r = (await (web as any)
      .evaluate?.({
        browserId: POST_TAB,
        expression: `(function(){
          window.scrollBy(0, Math.round(window.innerHeight * 0.8));
          return JSON.stringify({
            y: window.scrollY,
            h: document.body.scrollHeight,
            vh: window.innerHeight,
            d: document.querySelectorAll('div.img-comment').length
          });
        })()`,
      })
      .catch(() => null)) as { ok?: boolean; data?: string } | null;

    await sleep(260);

    if (!r?.data) continue;
    let info: { y: number; h: number; vh: number; d: number };
    try {
      info = JSON.parse(r.data);
    } catch {
      continue;
    }
    // Stop once the bottom is reached; no point burning steps on a short post.
    if (info.y + info.vh >= info.h - 4) break;
  }
  // Give the last batch of lazy-loaded threads time to arrive.
  await sleep(1500);

  const raw = (await web.html({ browserId: POST_TAB })) as { ok: boolean; data?: string };
  const html = raw?.data ?? '';
  if (!html) return {};

  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, noscript, style').forEach((e) => e.remove());

  const map: ImgCommentMap = {};
  doc.querySelectorAll('div.img-comment[id^="img_comment_div"]').forEach((d) => {
    const fileno = (d.getAttribute('id') ?? '').replace('img_comment_div', '').trim();
    if (!fileno) return;
    // `.all-comment.list` is the full thread. `.all-comment.preview` holds a
    // truncated teaser of the same comments -- reading both would duplicate them.
    const lis = Array.from(
      d.querySelectorAll('.all-comment.list ul.all-comment-lst > li.comment'),
    );
    const items: ImgComment[] = [];
    lis.forEach((li, i) => {
      const c = parseImgCommentItem(li, i);
      if (c) items.push(c);
    });
    if (items.length > 0) map[fileno] = items;
  });

  return map;
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
