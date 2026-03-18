import type { Post } from './types';
import { invoke } from '@bundled/yaar';

const GALLERY_ID = 'thesingularity';
const GALLERY_URL = `https://m.dcinside.com/board/${GALLERY_ID}`;

async function browseUrl(url: string, tabId: string, waitForIdle = false): Promise<string> {
  const openPayload: Record<string, unknown> = { action: 'open', url, visible: false, mobile: true };
  if (waitForIdle) openPayload.waitUntil = 'networkidle';
  await invoke('yaar://browser/' + tabId, openPayload);
  const result = await invoke('yaar://browser/' + tabId, { action: 'html' });
  return result.content[0]?.text ?? '';
}

/**
 * extract 액션을 사용해 URL을 열고 주요 텍스트 콘텐츠를 추출한다.
 * 반환값: { text: string, links: Array<{ label: string, url: string }> }
 */
async function extractUrl(
  url: string,
  tabId: string,
): Promise<{ text: string; links: Array<{ label: string; url: string }> }> {
  await invoke('yaar://browser/' + tabId, {
    action: 'open',
    url,
    visible: false,
    mobile: true,
    waitUntil: 'networkidle',
  });
  const result = await invoke('yaar://browser/' + tabId, {
    action: 'extract',
    mainContentOnly: true,
  });
  const raw = result.content[0]?.text ?? '';
  return parseExtractResult(raw);
}

/**
 * extract 액션이 반환하는 문자열을 파싱한다.
 */
function parseExtractResult(raw: string): { text: string; links: Array<{ label: string; url: string }> } {
  const textMatch = raw.match(/---\s*Text\s*---\n([\s\S]*?)(?=\n---\s*Links|$)/);
  const linksMatch = raw.match(/---\s*Links[^\n]*---\n([\s\S]*)$/);

  const text = textMatch ? textMatch[1].trim() : raw.trim();

  const links: Array<{ label: string; url: string }> = [];
  if (linksMatch) {
    const linkLines = linksMatch[1].split('\n');
    for (const line of linkLines) {
      const m = line.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (m) links.push({ label: m[1], url: m[2] });
    }
  }

  return { text, links };
}

/**
 * 줄이 메타데이터 패턴(숫자, 날짜, 시간, 조회/추천 레이블 등)인지 판별
 */
function isMetaLine(line: string): boolean {
  if (line.length <= 1) return true;
  if (/^\d+$/.test(line)) return true;           // 순수 숫자 (글번호, 조회수 등)
  if (/^\d{2}:\d{2}/.test(line)) return true;    // 시간 HH:MM
  if (/^\d{4}\.\d{2}/.test(line)) return true;   // 날짜 YYYY.MM
  if (/^\d{2}\.\d{2}/.test(line)) return true;   // 단축 날짜 MM.DD
  if (/^조회/.test(line)) return true;
  if (/^추천/.test(line)) return true;
  if (line === '이미지' || line === '동영상' || line === '설문' || line === 'AD') return true;
  return false;
}

export async function fetchPosts(): Promise<Post[]> {
  const html = await browseUrl(GALLERY_URL, 'singularity-list');
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // 모바일 DCinside: ul.gall-detail-lst > li
  const listEl = doc.querySelector('ul.gall-detail-lst');
  const liItems = listEl
    ? Array.from(listEl.querySelectorAll(':scope > li'))
    : Array.from(doc.querySelectorAll('ul.gall-detail-lst li'));

  const posts: Post[] = [];

  for (const li of liItems) {
    // 광고 li 제외
    if (li.classList.contains('advert') || li.querySelector('.ad-wrap, .aderror')) continue;

    // 메인 링크 (글번호 포함 URL, #comment_box 제외)
    const aEl = li.querySelector(`a[href*="/board/"][href*="/${GALLERY_ID}/"]:not([href*="#"])`) as HTMLAnchorElement | null
      ?? li.querySelector('a[href*="/board/"]') as HTMLAnchorElement | null;
    if (!aEl) continue;

    const href = aEl.getAttribute('href') ?? '';
    // URL 마지막 세그먼트에서 글번호 추출
    const urlMatch = href.match(/\/board\/[^/]+\/(\d+)\/?(?:\?.*)?$/);
    if (!urlMatch) continue;
    const num = urlMatch[1];

    // 공지글 제외
    if (!num || !/^\d+$/.test(num)) continue;

    const fullUrl = href.startsWith('http') ? href : 'https://m.dcinside.com' + href;

    // --- 조회수 / 추천수 DOM에서 직접 추출 ---
    let views = '0';
    let recommend = '0';

    const viewEl =
      li.querySelector('.view-cnt') ??
      li.querySelector('[class*="view"]') ??
      null;
    const recEl =
      li.querySelector('.recommend-cnt') ??
      li.querySelector('.rec-cnt') ??
      li.querySelector('[class*="recom"]') ??
      null;

    if (viewEl) {
      const m = (viewEl.textContent ?? '').match(/(\d+)/);
      if (m) views = m[1];
    }
    if (recEl) {
      const m = (recEl.textContent ?? '').match(/(\d+)/);
      if (m) recommend = m[1];
    }

    // DOM 탐색이 실패하면 rawText regex 방법 시도
    if (views === '0' && recommend === '0') {
      const liText = li.textContent ?? '';
      const viewsMatch = liText.match(/조회\s*(\d+)/);
      const recMatch = liText.match(/추천\s*(\d+)/);
      if (viewsMatch) views = viewsMatch[1];
      if (recMatch) recommend = recMatch[1];
    }

    // --- 제목 파싱 ---
    const TITLE_SELECTORS = [
      '.gall-tit-txt',
      '.ub-word',
      '.tit',
      '.subject',
      '.gall-tit',
    ];

    // 메타데이터 셀렉터 목록 (제목 추출 시 제거)
    const META_SELECTORS = [
      '.view-cnt', '.recommend-cnt', '.num-date', '.gall-num', '.gall-cnt',
      '.gall-writer', '.gall-info', '.rply-num', '.reply-num',
      '[class*="view"]', '[class*="recom"]', '[class*="cnt"]',
      '[class*="writer"]', '[class*="info"]', '[class*="num"]',
    ].join(', ');

    let titleRaw = '';

    for (const sel of TITLE_SELECTORS) {
      const titleEl = aEl.querySelector(sel);
      if (!titleEl) continue;
      const clone = titleEl.cloneNode(true) as Element;
      clone.querySelectorAll(META_SELECTORS).forEach(el => el.remove());
      const text = (clone.textContent ?? '').trim();
      if (text && !isMetaLine(text)) {
        titleRaw = text;
        break;
      }
    }

    // 2순위 fallback: aEl 전체에서 메타데이터 영역 제거 후
    if (!titleRaw) {
      const aClone = aEl.cloneNode(true) as Element;
      aClone.querySelectorAll(META_SELECTORS).forEach(el => el.remove());
      aClone.querySelectorAll('span, em').forEach(el => {
        const t = (el.textContent ?? '').trim();
        if (/^조회/.test(t) || /^추천/.test(t)) el.remove();
      });

      const allLines = (aClone.textContent ?? '')
        .split(/\n/)
        .map(s => s.trim())
        .filter(Boolean);

      const contentLines = allLines.filter(l => !isMetaLine(l));

      if (contentLines.length > 0) {
        titleRaw = contentLines.reduce((a, b) => b.length > a.length ? b : a, contentLines[0]);
      }

      if (!titleRaw) titleRaw = '(제목 없음)';
    }

    // 말머리 [카테고리] 처리
    const titleCategoryMatch = titleRaw.match(/^\[([^\]]+)\]/);
    const categoryFromTitle = titleCategoryMatch ? titleCategoryMatch[1].trim() : '';
    const title = titleCategoryMatch ? titleRaw.slice(titleCategoryMatch[0].length).trim() : titleRaw;

    // --- 작성자, 날짜, 카테고리 파싱 ---
    let author = '익명';
    let date = '';
    let category: string | undefined = categoryFromTitle || undefined;

    const writerEl = li.querySelector('.gall-writer, .wr-name, .nickname, [class*="writer"]');
    const dateEl = li.querySelector('.num-date, .gall-date, [class*="date"]');

    if (writerEl) {
      author = (writerEl.textContent ?? '').trim() || '익명';
    }
    if (dateEl) {
      date = (dateEl.textContent ?? '').trim();
    }

    // writerEl/dateEl 탐색 실패 시 텍스트 파싱 fallback
    if (author === '익명' && !date) {
      const aClone2 = aEl.cloneNode(true) as Element;
      aClone2.querySelectorAll(META_SELECTORS).forEach(el => el.remove());
      aClone2.querySelectorAll('span, em').forEach(el => {
        const t = (el.textContent ?? '').trim();
        if (/^조회/.test(t) || /^추천/.test(t)) el.remove();
      });
      const rawText2 = aClone2.textContent ?? '';
      const allLines2 = rawText2.split(/\n/).map(s => s.trim()).filter(Boolean);
      const infoLines = allLines2.filter(l => !isMetaLine(l) && l !== title && l !== titleRaw);

      if (infoLines.length >= 2) {
        const possibleCat = infoLines[0];
        const possibleAuthor = infoLines[1];
        const possibleDate = infoLines[2] ?? '';

        const isCategoryLike = possibleCat && possibleCat.length <= 10 && !/\d{2}:\d{2}/.test(possibleCat);
        if (isCategoryLike && !categoryFromTitle) {
          category = possibleCat;
          author = possibleAuthor || '익명';
          date = possibleDate;
        } else {
          author = possibleCat || '익명';
          date = possibleAuthor;
        }
      } else if (infoLines.length === 1) {
        author = infoLines[0] || '익명';
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

/**
 * DCinside 모바일 게시물 본문을 HTML로 가져온다.
 * extract 액션 대신 browseUrl + DOMParser 방식으로 실제 본문 컨테이너를 직접 파싱.
 * extract 액션은 DCinside에서 네비게이션/UI 텍스트를 본문으로 오인식하는 문제가 있음.
 */
export async function fetchPostContent(post: Post): Promise<string> {
  // 전체 HTML 가져오기 (networkidle 대기)
  const rawHtml = await browseUrl(post.url, 'singularity-post', true);
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');

  // 전역 위험 요소 제거
  doc.querySelectorAll('script, noscript, style').forEach(e => e.remove());

  // DCinside 모바일 본문 컨테이너 셀렉터 (우선순위 순)
  // .write_div   : 실제 본문 내용 div (가장 정확)
  // .thum-txt    : .write_div 의 부모 래퍼
  // .view_content_wrap : 전체 게시물 영역 폴백
  const CONTENT_SELECTORS = [
    '.write_div',
    '.thum-txt',
    '.view_content_wrap',
    '.gallview_contents',
    '#readBody',
  ];

  // .view_content_wrap 를 선택할 경우 제거할 불필요한 자식 요소들
  const REMOVE_INSIDE = [
    '.gallview-tit-wrap',  // 제목 (헤더에 이미 표시)
    '.gallview-head',      // 작성자/날짜/조회수 메타 (헤더에 이미 표시)
    '.view_content_bottom',// 반응 버튼 영역
    '.bottom_nav',         // 하단 네비게이션
    '.comment_wrap',       // 댓글 영역
    '.reply_wrap',
    '.ad', '.adsbygoogle', '.float_ad',
  ].join(', ');

  for (const sel of CONTENT_SELECTORS) {
    const el = doc.querySelector(sel) as HTMLElement | null;
    if (!el) continue;

    // 불필요한 하위 요소 제거
    el.querySelectorAll(REMOVE_INSIDE).forEach(e => e.remove());

    const textContent = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    // 의미 있는 텍스트가 있는 경우만 사용
    if (textContent.length > 20) {
      return el.innerHTML.trim();
    }
  }

  // 모든 셀렉터 실패 시 안내 메시지
  const safeUrl = post.url.replace(/"/g, '&quot;');
  return `<p style="color:#8b949e">본문을 불러올 수 없습니다. <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--yaar-accent)">DC에서 직접 보기 ↗</a></p>`;
}

/**
 * 분석용: 상위 N개 게시물 내용 가져오기
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
        new Promise<{ post: Post; text: string }>(resolve => {
          setTimeout(async () => {
            try {
              const tabId = `singularity-rec-${i % 3}`;
              // DOMParser로 본문 추출
              const rawHtml = await browseUrl(post.url, tabId, true);
              const parser = new DOMParser();
              const doc = parser.parseFromString(rawHtml, 'text/html');
              doc.querySelectorAll('script, noscript, style').forEach(e => e.remove());

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
