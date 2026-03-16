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
 * 형식:
 *   URL: ...
 *   Title: ...
 *
 *   --- Text ---
 *   (본문 텍스트)
 *
 *   --- Links (N) ---
 *   [label](url)
 *   ...
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

/** li 요소에서 텍스트 숫자를 안전하게 추출 (조회/추천 레이블 유무 모두 처리) */
function extractCountFromEl(li: Element, labelSelector: string, labelText: string): string {
  // 1) 레이블 기반 셀렉터 시도
  const el = li.querySelector(labelSelector);
  if (el) {
    const text = (el.textContent ?? '').trim();
    const m = text.match(/(\d+)/);
    if (m) return m[1];
  }
  // 2) 레이블 텍스트를 포함하는 span/em 탐색
  const allSpans = Array.from(li.querySelectorAll('span, em, b'));
  for (const span of allSpans) {
    const t = (span.textContent ?? '').trim();
    if (t.startsWith(labelText)) {
      const m = t.match(/(\d+)/);
      if (m) return m[1];
    }
  }
  return '0';
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
    // URL 마지막 세그먼트에서 글번호 추출 (/board/thesingularity/1234567)
    const urlMatch = href.match(/\/board\/[^/]+\/(\d+)\/?(?:\?.*)?$/);
    if (!urlMatch) continue;
    const num = urlMatch[1];

    // 공지글 제외 (num이 숫자가 아닌 경우)
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

    // --- 제목 파싱: aEl 내부에서 title 전용 요소 탐색 ---
    const titleEl =
      aEl.querySelector('.tit') ??
      aEl.querySelector('.subject') ??
      aEl.querySelector('.gall-tit') ??
      null;

    let titleRaw = '';
    if (titleEl) {
      const titleClone = titleEl.cloneNode(true) as Element;
      titleClone.querySelectorAll('.view-cnt, .recommend-cnt, .num-date, [class*="view"], [class*="recom"], [class*="cnt"]')
        .forEach(el => el.remove());
      titleRaw = (titleClone.textContent ?? '').trim();
    }

    if (!titleRaw) {
      const aClone = aEl.cloneNode(true) as Element;
      aClone.querySelectorAll('.view-cnt, .recommend-cnt, .num-date, .gall-num, [class*="view"], [class*="recom"], [class*="cnt"]')
        .forEach(el => el.remove());
      aClone.querySelectorAll('span, em').forEach(el => {
        const t = (el.textContent ?? '').trim();
        if (/^조회/.test(t) || /^추천/.test(t)) el.remove();
      });
      const lines = (aClone.textContent ?? '')
        .split(/\n/).map(s => s.trim()).filter(Boolean);
      const cleanLines = lines[0] === '이미지' ? lines.slice(1) : lines;
      titleRaw = cleanLines[0] ?? '(제목 없음)';
    }

    // 말머리 [카테고리] 처리
    const titleCategoryMatch = titleRaw.match(/^\[([^\]]+)\]/);
    const categoryFromTitle = titleCategoryMatch ? titleCategoryMatch[1].trim() : '';
    const title = titleCategoryMatch ? titleRaw.slice(titleCategoryMatch[0].length).trim() : titleRaw;

    // --- 작성자, 날짜, 카테고리 파싱 ---
    const aClone2 = aEl.cloneNode(true) as Element;
    aClone2.querySelectorAll('.view-cnt, .recommend-cnt, .num-date, .gall-num, [class*="view"], [class*="recom"], [class*="cnt"]')
      .forEach(el => el.remove());
    aClone2.querySelectorAll('span, em').forEach(el => {
      const t = (el.textContent ?? '').trim();
      if (/^조회/.test(t) || /^추천/.test(t)) el.remove();
    });
    const rawText2 = aClone2.textContent ?? '';
    const allLines = rawText2.split(/\n/).map(s => s.trim()).filter(Boolean);
    const cleanLines2 = allLines[0] === '이미지' ? allLines.slice(1) : allLines;
    const infoLines = cleanLines2.filter(l => !/^조회/.test(l) && !/^추천/.test(l));

    let category: string | undefined = undefined;
    let author = '익명';
    let date = '';

    if (infoLines.length >= 3) {
      const possibleCat = infoLines[1];
      const possibleAuthor = infoLines[2];
      const possibleDate = infoLines[3] ?? '';

      const isCategoryLike = possibleCat && possibleCat.length <= 10 && !/\d{2}:\d{2}/.test(possibleCat);
      if (isCategoryLike) {
        category = categoryFromTitle || possibleCat || undefined;
        author = possibleAuthor || '익명';
        date = possibleDate;
      } else {
        category = categoryFromTitle || undefined;
        author = possibleCat || '익명';
        date = possibleAuthor;
      }
    } else if (infoLines.length === 2) {
      category = categoryFromTitle || undefined;
      author = infoLines[1] || '익명';
    } else {
      category = categoryFromTitle || undefined;
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
 * extract 액션으로 게시물 본문을 가져와 HTML 문자열로 반환한다.
 * 텍스트 단락을 <p> 태그로 변환하고, 링크 섹션을 별도 블록으로 첨부한다.
 */
export async function fetchPostContent(post: Post): Promise<string> {
  const { text, links } = await extractUrl(post.url, 'singularity-post');

  if (!text && links.length === 0) {
    return '<p style="color:#8b949e">내용을 불러올 수 없습니다.</p>';
  }

  // 텍스트를 빈 줄 기준으로 단락 분리하여 <p> 태그로 감싼다
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // 단락 내 줄바꿈을 <br>로 변환
      return '<p>' + escaped.replace(/\n/g, '<br>') + '</p>';
    })
    .join('');

  // 링크 섹션 (존재하는 경우)
  let linksHtml = '';
  if (links.length > 0) {
    const linkItems = links
      .map(l => {
        const labelEsc = l.label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const urlEsc = l.url.replace(/"/g, '&quot;');
        return `<li><a href="${urlEsc}" target="_blank" rel="noopener noreferrer" style="color:var(--yaar-accent)">${labelEsc}</a></li>`;
      })
      .join('');
    linksHtml = `<div class="post-links"><div class="post-links-title" style="color:var(--yaar-text-muted);font-size:12px;margin-top:16px;margin-bottom:4px">링크</div><ul style="margin:0;padding-left:18px;font-size:13px">${linkItems}</ul></div>`;
  }

  return paragraphs + linksHtml || '<p style="color:#8b949e">내용을 불러올 수 없습니다.</p>';
}

/**
 * 분석용: 상위 N개 게시물 내용 가져오기
 * 3개 탭을 1초 간격으로 병렬 실행, extract 액션으로 깔끔한 텍스트 추출
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
              await invoke('yaar://browser/' + tabId, {
                action: 'open',
                url: post.url,
                visible: false,
                mobile: true,
                waitUntil: 'networkidle',
              });
              const result = await invoke('yaar://browser/' + tabId, {
                action: 'extract',
                mainContentOnly: true,
              });
              const raw = result.content[0]?.text ?? '';
              const { text } = parseExtractResult(raw);
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
