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

    // 말머리 (카테고리) 요소 파싱
    const categoryEl =
      titEl.querySelector('.말머리') ??
      titEl.querySelector('.badge') ??
      titEl.querySelector('em.sp_img, em[class*="icon"]');
    const categoryRaw =
      categoryEl?.textContent?.trim() ||
      categoryEl?.getAttribute('title') ||
      categoryEl?.getAttribute('alt') ||
      '';
    // 대괄호 제거 ex) [도배기] → 도배기
    const categoryFromEl = categoryRaw ? categoryRaw.replace(/^\[|\]$/g, '').trim() : '';

    // a 태그 전체 텍스트에서 제목 추출 (말머리가 포함될 수 있음)
    const titleRaw = aEl?.textContent?.trim() ?? '(제목 없음)';
    // 제목이 [유형]으로 시작하면 카테고리로 추출
    const titleCategoryMatch = titleRaw.match(/^\[([^\]]+)\]/);
    const categoryFromTitle = titleCategoryMatch ? titleCategoryMatch[1].trim() : '';
    // 제목에서 [카테고리] 부분 제거
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
    // 스크립트 / 광고 제거
    contentEl.querySelectorAll('script, iframe, ins').forEach((el) => el.remove());

    // DC Inside 원본 HTML의 onerror, onclick 등 인라인 핸들러 제거 (reload_img 미정의 오류 방지)
    contentEl.querySelectorAll('[onerror]').forEach((el) => el.removeAttribute('onerror'));
    contentEl.querySelectorAll('[onclick]').forEach((el) => el.removeAttribute('onclick'));
    contentEl.querySelectorAll('[onload]').forEach((el) => el.removeAttribute('onload'));

    // 이미지 src 절대경로 변환 후 Referer 헤더 포함 프록시로 교체 (403 방지)
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

      // dcinside 이미지는 Referer 없이 403 → 프록시로 우회
      const dataUrl = await proxyImage(absoluteSrc, post.url);
      img.setAttribute('src', dataUrl ?? absoluteSrc);
      img.style.maxWidth = '100%';
    }));

    return contentEl.innerHTML || '<p style="color:#8b949e">내용을 불러올 수 없습니다.</p>';
  }

  return '<p style="color:#8b949e">내용을 불러올 수 없습니다.</p>';
}
