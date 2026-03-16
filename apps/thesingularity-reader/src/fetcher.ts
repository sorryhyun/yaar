import type { Post } from './types';

const GALLERY_ID = 'thesingularity';
const GALLERY_URL = `https://gall.dcinside.com/mgallery/board/lists/?id=${GALLERY_ID}`;
const POST_BASE_URL = `https://gall.dcinside.com/mgallery/board/view/?id=${GALLERY_ID}&no=`;

async function browseUrl(url: string, tabId: string): Promise<string> {
  await window.yaar.invoke('yaar://browser/' + tabId, { action: 'open', url, visible: false });
  const result = await window.yaar.invoke('yaar://browser/' + tabId, { action: 'html' });
  return result.content[0]?.text ?? '';
}

/** 이미지를 yaar://http 프록시로 가져와 data URL로 변환 (Referer 헤더 포함) */
async function proxyImage(src: string, referer: string): Promise<string | null> {
  try {
    const result = await window.yaar.invoke('yaar://http', {
      url: src,
      method: 'GET',
      headers: { Referer: referer },
    });
    const data = JSON.parse(result.content[0]?.text ?? 'null');
    if (!data?.ok || !data?.body) return null;
    const mime = (data.headers?.['content-type'] ?? data.headers?.['Content-Type'] ?? 'image/jpeg')
      .split(';')[0].trim();
    return `data:${mime};base64,${data.body}`;
  } catch {
    return null;
  }
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

    const categoryEl =
      titEl.querySelector('.말머리') ??
      titEl.querySelector('.badge') ??
      titEl.querySelector('em.sp_img, em[class*="icon"]');
    const categoryRaw =
      categoryEl?.textContent?.trim() ||
      categoryEl?.getAttribute('title') ||
      categoryEl?.getAttribute('alt') ||
      '';
    const categoryFromEl = categoryRaw ? categoryRaw.replace(/^\[|\]$/g, '').trim() : '';

    const titleRaw = aEl?.textContent?.trim() ?? '(제목 없음)';
    const titleCategoryMatch = titleRaw.match(/^\[([^\]]+)\]/);
    const categoryFromTitle = titleCategoryMatch ? titleCategoryMatch[1].trim() : '';
    const title = titleCategoryMatch ? titleRaw.slice(titleCategoryMatch[0].length).trim() : titleRaw;
    const category = categoryFromEl || categoryFromTitle || undefined;

    const href = aEl?.getAttribute('href') ?? '';
    const fullUrl = href
      ? href.startsWith('http') ? href : 'https://gall.dcinside.com' + href
      : POST_BASE_URL + num;

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

    const inlineHandlers = ['onerror', 'onclick', 'onload', 'onmouseover', 'onmouseout', 'onmouseenter', 'onmouseleave'];
    contentEl.querySelectorAll('*').forEach((el) => {
      inlineHandlers.forEach(attr => el.removeAttribute(attr));
    });

    const imgEls = Array.from(contentEl.querySelectorAll('img'));
    await Promise.all(imgEls.map(async (img) => {
      const rawSrc = img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (!rawSrc) { img.removeAttribute('src'); return; }

      const absoluteSrc = rawSrc.startsWith('//')
        ? 'https:' + rawSrc
        : rawSrc.startsWith('/')
          ? 'https://gall.dcinside.com' + rawSrc
          : rawSrc;

      img.removeAttribute('data-src');

      const dataUrl = await proxyImage(absoluteSrc, post.url);
      img.setAttribute('src', dataUrl ?? absoluteSrc);
      img.style.maxWidth = '100%';
    }));

    return contentEl.innerHTML || '<p style="color:#8b949e">내용을 불러올 수 없습니다.</p>';
  }

  return '<p style="color:#8b949e">내용을 불러올 수 없습니다.</p>';
}

/**
 * 분석용: 상위 N개 게시물 내용 가져오기
 * 3개 탭을 1초 간격으로 병렬 실행
 */
export async function fetchTopPostsForAnalysis(
  allPosts: Post[],
  count = 5,
): Promise<Array<{ post: Post; text: string }>> {
  // 추천수 내림차순으로 정렬
  const candidates = [...allPosts]
    .sort((a, b) => (parseInt(b.recommend) || 0) - (parseInt(a.recommend) || 0))
    .slice(0, count);

  const results = await Promise.all(
    candidates.map(
      (post, i) =>
        new Promise<{ post: Post; text: string }>(resolve => {
          setTimeout(async () => {
            try {
              const tabId = `singularity-rec-${i % 3}`;
              await window.yaar.invoke('yaar://browser/' + tabId, {
                action: 'open',
                url: post.url,
                visible: false,
              });
              const result = await window.yaar.invoke('yaar://browser/' + tabId, { action: 'html' });
              const rawHtml = result.content[0]?.text ?? '';
              const parser = new DOMParser();
              const doc = parser.parseFromString(rawHtml, 'text/html');
              const el =
                doc.querySelector('.write_div') ??
                doc.querySelector('#thum-ph') ??
                doc.querySelector('#writing_part');
              const text = el
                ? (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
                : '';
              resolve({ post, text });
            } catch {
              resolve({ post, text: '' });
            }
          }, i * 1000);
        }),
    ),
  );

  return results;
}
