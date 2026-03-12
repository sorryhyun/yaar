import type { Post } from './types';

const GALLERY_ID = 'thesingularity';
const GALLERY_URL = `https://gall.dcinside.com/mgallery/board/lists/?id=${GALLERY_ID}`;
const POST_BASE_URL = `https://gall.dcinside.com/mgallery/board/view/?id=${GALLERY_ID}&no=`;

export async function fetchPosts(): Promise<Post[]> {
  const res = await fetch(GALLERY_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://gall.dcinside.com/',
    },
  });
  if (!res.ok) throw new Error(`Fetch error: ${res.status}`);
  const html = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Try main list selector first, fallback to ub-content
  let rows = Array.from(doc.querySelectorAll('table.gall_list tbody tr.ub-content'));
  if (rows.length === 0) {
    rows = Array.from(doc.querySelectorAll('tr.ub-content'));
  }

  const posts: Post[] = [];

  rows.forEach((row) => {
    // Skip notices and ads
    if (row.classList.contains('notice') || row.classList.contains('gall_notice')) return;
    if (row.classList.contains('advert')) return;
    if (row.querySelector('.sp_img.icon_notice, .icon_notice')) return;

    // Must have a title cell
    const titEl = row.querySelector('td.gall_tit');
    if (!titEl) return;

    const numEl = row.querySelector('td.gall_num');
    const num = numEl?.textContent?.trim() ?? '';

    // Skip non-numeric post numbers (notices)
    if (!num || !/^\d+$/.test(num)) return;

    // Title: exclude reply count link
    const aEl = titEl.querySelector('a:not(.reply_num)');
    const title = aEl?.textContent?.trim() ?? '(제목 없음)';

    // Href from the link
    const href = aEl?.getAttribute('href') ?? '';
    const fullUrl = href
      ? href.startsWith('http')
        ? href
        : 'https://gall.dcinside.com' + href
      : POST_BASE_URL + num;

    // Category (말머리)
    const categoryEl =
      titEl.querySelector('.말머리') ??
      titEl.querySelector('.badge') ??
      titEl.querySelector('em.sp_img, em[class*="icon"]');
    const category =
      categoryEl?.textContent?.trim() ||
      categoryEl?.getAttribute('title') ||
      categoryEl?.getAttribute('alt') ||
      undefined;

    // Author
    const authorEl = row.querySelector('td.gall_writer');
    const author =
      authorEl?.querySelector('.nickname')?.textContent?.trim() ??
      authorEl?.querySelector('.name_txt')?.textContent?.trim() ??
      authorEl?.textContent?.trim() ??
      '익명';

    // Date
    const dateEl = row.querySelector('td.gall_date');
    const date = dateEl?.getAttribute('title') ?? dateEl?.textContent?.trim() ?? '';

    // Views
    const viewsEl = row.querySelector('td.gall_count');
    const views = viewsEl?.textContent?.trim() ?? '0';

    // Recommend
    const recEl = row.querySelector('td.gall_recommend');
    const recommend = recEl?.textContent?.trim() ?? '0';

    const id = `post-${num}`;

    posts.push({
      id,
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
  });

  return posts;
}

export async function fetchPostContent(post: Post): Promise<string> {
  const res = await fetch(post.url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://gall.dcinside.com/',
    },
  });
  if (!res.ok) throw new Error(`Fetch error: ${res.status}`);
  const html = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Try various content selectors
  const contentEl =
    doc.querySelector('.write_div') ??
    doc.querySelector('#writing_part') ??
    doc.querySelector('.post-content') ??
    doc.querySelector('.thum-ph') ??
    doc.querySelector('.gallview-container .write_div') ??
    doc.querySelector('#thum-ph');

  if (contentEl) {
    // Remove scripts and iframes from content
    contentEl.querySelectorAll('script, iframe, ins').forEach((el) => el.remove());

    // Fix image src to use absolute URLs
    contentEl.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || img.getAttribute('data-src');
      if (src) {
        const absoluteSrc = src.startsWith('//')
          ? 'https:' + src
          : src.startsWith('/')
            ? 'https://gall.dcinside.com' + src
            : src;
        img.setAttribute('src', absoluteSrc);
        img.removeAttribute('data-src');
      }
    });

    return contentEl.innerHTML || '<p style="color:#8b949e">내용을 불러올 수 없습니다.</p>';
  }

  return '<p style="color:#8b949e">내용을 불러올 수 없습니다.</p>';
}
