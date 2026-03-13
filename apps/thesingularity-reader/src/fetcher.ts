import type { Post } from './types';

const GALLERY_ID = 'thesingularity';
const GALLERY_URL = `https://gall.dcinside.com/mgallery/board/lists/?id=${GALLERY_ID}`;
const POST_BASE_URL = `https://gall.dcinside.com/mgallery/board/view/?id=${GALLERY_ID}&no=`;

async function browseUrl(url: string, tabId: string): Promise<string> {
  await window.yaar.invoke('yaar://browser/' + tabId, { action: 'open', url, visible: false });
  const result = await window.yaar.invoke('yaar://browser/' + tabId, { action: 'html' });
  return result.content[0]?.text ?? '';
}

export async function fetchPosts(): Promise<Post[]> {
  const html = await browseUrl(GALLERY_URL, 'singularity-list');
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  let rows = Array.from(doc.querySelectorAll('table.gall_list tbody tr.ub-content'));
  if (rows.length === 0) {
    rows = Array.from(doc.querySelectorAll('tr.ub-content'));
  }

  const posts: Post[] = [];

  rows.forEach((row) => {
    if (row.classList.contains('notice') || row.classList.contains('gall_notice')) return;
    if (row.classList.contains('advert')) return;
    if (row.querySelector('.sp_img.icon_notice, .icon_notice')) return;

    const titEl = row.querySelector('td.gall_tit');
    if (!titEl) return;

    const numEl = row.querySelector('td.gall_num');
    const num = numEl?.textContent?.trim() ?? '';
    if (!num || !/^\d+$/.test(num)) return;

    const aEl = titEl.querySelector('a:not(.reply_num)');
    const title = aEl?.textContent?.trim() ?? '(제목 없음)';

    const href = aEl?.getAttribute('href') ?? '';
    const fullUrl = href
      ? href.startsWith('http') ? href : 'https://gall.dcinside.com' + href
      : POST_BASE_URL + num;

    const categoryEl =
      titEl.querySelector('.말머리') ??
      titEl.querySelector('.badge') ??
      titEl.querySelector('em.sp_img, em[class*="icon"]');
    const category =
      categoryEl?.textContent?.trim() ||
      categoryEl?.getAttribute('title') ||
      categoryEl?.getAttribute('alt') ||
      undefined;

    const authorEl = row.querySelector('td.gall_writer');
    const author =
      authorEl?.querySelector('.nickname')?.textContent?.trim() ??
      authorEl?.querySelector('.name_txt')?.textContent?.trim() ??
      authorEl?.textContent?.trim() ??
      '익명';

    const dateEl = row.querySelector('td.gall_date');
    const date = dateEl?.getAttribute('title') ?? dateEl?.textContent?.trim() ?? '';

    const viewsEl = row.querySelector('td.gall_count');
    const views = viewsEl?.textContent?.trim() ?? '0';

    const recEl = row.querySelector('td.gall_recommend');
    const recommend = recEl?.textContent?.trim() ?? '0';

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
  });

  return posts;
}

export async function fetchPostContent(post: Post): Promise<string> {
  const html = await browseUrl(post.url, 'singularity-post');
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const contentEl =
    doc.querySelector('.write_div') ??
    doc.querySelector('#writing_part') ??
    doc.querySelector('.post-content') ??
    doc.querySelector('.thum-ph') ??
    doc.querySelector('.gallview-container .write_div') ??
    doc.querySelector('#thum-ph');

  if (contentEl) {
    contentEl.querySelectorAll('script, iframe, ins').forEach((el) => el.remove());
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
