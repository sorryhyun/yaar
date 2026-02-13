type DailyPaperItem = {
  paper?: {
    id?: string;
    title?: string;
    summary?: string;
    publishedAt?: string;
    ai_summary?: string;
    upvotes?: number;
    authors?: Array<{ name?: string }>;
  };
  title?: string;
  summary?: string;
  publishedAt?: string;
  thumbnail?: string;
  numComments?: number;
  upvotes?: number;
  submittedBy?: { fullname?: string; name?: string };
  organization?: { fullname?: string; name?: string };
};

type Recommendation = {
  id: string;
  title: string;
  reason: string;
  upvotes: number;
  comments: number;
};

const app = document.createElement('div');
app.innerHTML = `
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1117;
      --panel: #161a22;
      --muted: #9aa3b2;
      --text: #e7ecf3;
      --accent: #6ea8fe;
      --border: #2a3140;
      --good: #9ad08f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      overflow-y: auto;
    }
    .wrap { max-width: 980px; margin: 0 auto; padding: 16px; }
    .top { display:flex; gap:10px; align-items:center; flex-wrap: wrap; margin-bottom: 14px; }
    h1 { margin:0; font-size: 20px; }
    .spacer { flex:1; }
    .muted { color: var(--muted); font-size: 13px; }
    button, select {
      background: #202838; color: var(--text); border: 1px solid var(--border);
      border-radius: 10px; padding: 8px 10px; font: inherit; cursor: pointer;
    }
    button:hover { border-color: #3b4660; }
    .recommend-btn { border-color: #385995; }
    .recommend-box {
      margin-top: 10px;
      margin-bottom: 10px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: #141a25;
      display: none;
    }
    .recommend-title { margin: 0 0 8px; color: var(--good); font-size: 14px; }
    .recommend-item { margin: 0 0 8px; font-size: 13px; color: #d5deea; }
    .recommend-item:last-child { margin-bottom: 0; }
    .recommend-item a { color: var(--accent); text-decoration: none; }
    .recommend-item a:hover { text-decoration: underline; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .card-inner { display: grid; grid-template-columns: 170px 1fr; gap: 12px; }
    .thumb { width: 100%; height: 100%; min-height: 130px; object-fit: cover; background: #11151f; }
    .content { padding: 12px 14px 14px 0; }
    .title { margin: 0 0 8px; font-size: 17px; line-height: 1.3; }
    .title a { color: var(--text); text-decoration: none; }
    .title a:hover { color: var(--accent); text-decoration: underline; }
    .meta { display:flex; gap:10px; flex-wrap:wrap; color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    .summary { margin: 0; color: #cdd6e3; font-size: 14px; line-height: 1.45; }
    .links { margin-top: 10px; display:flex; gap:10px; }
    .links a { color: var(--accent); font-size: 13px; text-decoration: none; }
    .links a:hover { text-decoration: underline; }
    .empty { padding: 24px; text-align:center; border: 1px dashed var(--border); border-radius: 12px; color: var(--muted); }
    @media (max-width: 760px) {
      .card-inner { grid-template-columns: 1fr; }
      .content { padding: 0 12px 12px 12px; }
      .thumb { min-height: 180px; }
    }
  </style>
  <div class="wrap">
    <div class="top">
      <h1>📚 Recent Papers</h1>
      <span class="muted">Source: Hugging Face Daily Papers</span>
      <div class="spacer"></div>

      <label class="muted" for="limit">Limit</label>
      <select id="limit">
        <option value="10">10</option>
        <option value="20" selected>20</option>
        <option value="40">40</option>
      </select>

      <label class="muted" for="dayRange">Days</label>
      <select id="dayRange">
        <option value="all" selected>All</option>
        <option value="1">1 day</option>
        <option value="3">3 days</option>
        <option value="7">7 days</option>
        <option value="14">14 days</option>
        <option value="30">30 days</option>
      </select>

      <label class="muted" for="sortBy">Sort</label>
      <select id="sortBy">
        <option value="newest" selected>Newest</option>
        <option value="oldest">Oldest</option>
        <option value="vote">Most votes</option>
        <option value="comments">Most comments</option>
        <option value="title">Title (A→Z)</option>
      </select>

      <button id="recommend2" class="recommend-btn">Recommend 2 papers</button>
      <button id="refresh">Refresh</button>
    </div>
    <div id="status" class="muted">Loading…</div>
    <div id="recommendations" class="recommend-box"></div>
    <div id="list" class="grid" style="margin-top:10px"></div>
  </div>
`;

document.body.appendChild(app);

const statusEl = document.getElementById('status') as HTMLDivElement;
const listEl = document.getElementById('list') as HTMLDivElement;
const limitEl = document.getElementById('limit') as HTMLSelectElement;
const dayRangeEl = document.getElementById('dayRange') as HTMLSelectElement;
const sortByEl = document.getElementById('sortBy') as HTMLSelectElement;
const recommendBoxEl = document.getElementById('recommendations') as HTMLDivElement;
const recommendBtn = document.getElementById('recommend2') as HTMLButtonElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;

let sourcePapers: DailyPaperItem[] = [];
let papers: DailyPaperItem[] = [];
let recommendations: Recommendation[] = [];
let paperDetailsCache: Record<string, any> = {};
let loading = false;

function formatDate(iso?: string) {
  if (!iso) return 'Unknown date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function getPublishedAt(item: DailyPaperItem): string | undefined {
  return item?.paper?.publishedAt || item?.publishedAt;
}

function getPublishedMs(item: DailyPaperItem): number {
  const iso = getPublishedAt(item);
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function getUpvotes(item: DailyPaperItem): number {
  const v = item?.paper?.upvotes ?? item?.upvotes ?? 0;
  return Number.isFinite(v) ? v : 0;
}

function getComments(item: DailyPaperItem): number {
  const c = item?.numComments ?? 0;
  return Number.isFinite(c) ? c : 0;
}

function paperId(item: DailyPaperItem): string {
  return item?.paper?.id || 'unknown';
}

function paperTitle(item: DailyPaperItem): string {
  return item?.paper?.title || item?.title || 'Untitled paper';
}

function paperSummary(item: DailyPaperItem): string {
  return item?.paper?.ai_summary || item?.summary || item?.paper?.summary || 'No summary available.';
}

function applyFiltersAndSort() {
  const dayRange = dayRangeEl.value;
  const sortBy = sortByEl.value;

  let result = [...sourcePapers];

  if (dayRange !== 'all') {
    const days = Number(dayRange);
    if (Number.isFinite(days) && days > 0) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      result = result.filter((item) => getPublishedMs(item) >= cutoff);
    }
  }

  if (sortBy === 'newest') {
    result.sort((a, b) => getPublishedMs(b) - getPublishedMs(a));
  } else if (sortBy === 'oldest') {
    result.sort((a, b) => getPublishedMs(a) - getPublishedMs(b));
  } else if (sortBy === 'vote') {
    result.sort((a, b) => {
      const dv = getUpvotes(b) - getUpvotes(a);
      if (dv !== 0) return dv;
      const dc = getComments(b) - getComments(a);
      if (dc !== 0) return dc;
      return getPublishedMs(b) - getPublishedMs(a);
    });
  } else if (sortBy === 'comments') {
    result.sort((a, b) => getComments(b) - getComments(a));
  } else if (sortBy === 'title') {
    result.sort((a, b) => paperTitle(a).localeCompare(paperTitle(b)));
  }

  papers = result;
}

function renderRecommendations() {
  if (!recommendations.length) {
    recommendBoxEl.style.display = 'none';
    recommendBoxEl.innerHTML = '';
    return;
  }

  recommendBoxEl.style.display = 'block';
  recommendBoxEl.innerHTML = `
    <h3 class="recommend-title">🤖 Today's 2 recommended papers</h3>
    ${recommendations
      .map(
        (r, i) => `
      <p class="recommend-item">
        <strong>${i + 1}.</strong>
        <a href="https://huggingface.co/papers/${r.id}" target="_blank" rel="noreferrer">${r.title}</a>
        — ${r.reason} (👍 ${r.upvotes}, 💬 ${r.comments})
      </p>
    `,
      )
      .join('')}
  `;
}

function render() {
  statusEl.textContent = loading
    ? 'Loading papers...'
    : `Showing ${papers.length} of ${sourcePapers.length} papers • Last updated ${new Date().toLocaleTimeString()}`;

  renderRecommendations();

  if (!papers.length) {
    listEl.innerHTML = '<div class="empty">No papers available for this filter.</div>';
    return;
  }

  listEl.innerHTML = papers
    .map((item) => {
      const id = paperId(item);
      const title = paperTitle(item);
      const summary = paperSummary(item);
      const published = getPublishedAt(item);
      const org = item?.organization?.fullname || item?.organization?.name;
      const comments = getComments(item);
      const upvotes = getUpvotes(item);
      const thumbnail = item?.thumbnail || 'https://huggingface.co/front/assets/huggingface_logo-noborder.svg';
      return `
        <article class="card">
          <div class="card-inner">
            <img class="thumb" src="${thumbnail}" alt="thumbnail for ${title.replace(/"/g, '&quot;')}" loading="lazy" />
            <div class="content">
              <h2 class="title"><a href="https://huggingface.co/papers/${id}" target="_blank" rel="noreferrer">${title}</a></h2>
              <div class="meta">
                <span>🗓 ${formatDate(published)}</span>
                <span>👍 ${upvotes}</span>
                <span>💬 ${comments} comments</span>
                ${org ? `<span>🏢 ${org}</span>` : ''}
              </div>
              <p class="summary">${summary}</p>
              <div class="links">
                <a href="https://huggingface.co/papers/${id}" target="_blank" rel="noreferrer">Hugging Face</a>
                <a href="https://arxiv.org/abs/${id}" target="_blank" rel="noreferrer">arXiv</a>
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function getApiSort(sortBy: string): 'publishedAt' | 'trending' {
  return sortBy === 'vote' ? 'trending' : 'publishedAt';
}

async function fetchPaperDetailsById(id: string) {
  const cleanId = String(id || '').trim();
  if (!cleanId) throw new Error('Missing paper id');

  if (paperDetailsCache[cleanId]) return paperDetailsCache[cleanId];

  const resp = await fetch(`https://huggingface.co/api/papers/${encodeURIComponent(cleanId)}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();

  const normalized = {
    id: data?.id || cleanId,
    title: data?.title || '',
    summary: data?.summary || '',
    aiSummary: data?.ai_summary || '',
    keywords: Array.isArray(data?.ai_keywords) ? data.ai_keywords : [],
    authors: Array.isArray(data?.authors) ? data.authors.map((a: any) => a?.name).filter(Boolean) : [],
    upvotes: Number(data?.upvotes || 0),
    publishedAt: data?.publishedAt || '',
    projectPage: data?.projectPage || '',
    githubRepo: data?.githubRepo || '',
    githubStars: Number(data?.githubStars || 0),
    links: {
      huggingFace: `https://huggingface.co/papers/${data?.id || cleanId}`,
      arxiv: `https://arxiv.org/abs/${data?.id || cleanId}`,
    },
  };

  paperDetailsCache[cleanId] = normalized;
  return normalized;
}

async function loadPapers() {
  if (loading) return;
  loading = true;
  render();
  try {
    const limit = Number(limitEl.value || 20);
    const apiSort = getApiSort(sortByEl.value);
    const resp = await fetch(`https://huggingface.co/api/daily_papers?limit=${limit}&sort=${apiSort}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as DailyPaperItem[];
    sourcePapers = Array.isArray(data) ? data : [];
    applyFiltersAndSort();
  } catch (err: any) {
    sourcePapers = [];
    papers = [];
    statusEl.textContent = `Failed to load papers: ${err?.message || String(err)}`;
  } finally {
    loading = false;
    render();
  }
}

function onFilterOrSortChanged() {
  applyFiltersAndSort();
  render();
}

function requestRecommendationsFromAgent(source: 'button' | 'app-command') {
  const payload = {
    event: 'recent-papers:recommend-2',
    source,
    date: new Date().toISOString(),
    context: {
      limit: Number(limitEl.value || 20),
      dayRange: dayRangeEl.value,
      sortBy: sortByEl.value,
      visibleCount: papers.length,
    },
    papers: papers.slice(0, Math.max(1, Number(limitEl.value || 20))).map((p) => ({
      id: paperId(p),
      title: paperTitle(p),
      summary: p?.summary || p?.paper?.summary || '',
      aiSummary: p?.paper?.ai_summary || '',
      upvotes: getUpvotes(p),
      comments: getComments(p),
      publishedAt: getPublishedAt(p),
      authors: (p?.paper?.authors || []).map((a) => a?.name).filter(Boolean),
      links: {
        huggingFace: `https://huggingface.co/papers/${paperId(p)}`,
        arxiv: `https://arxiv.org/abs/${paperId(p)}`,
      },
    })),
  };

  (window as any).yaar?.app?.sendInteraction?.(payload);
}

refreshBtn.addEventListener('click', () => {
  loadPapers();
});

limitEl.addEventListener('change', () => {
  loadPapers();
});

dayRangeEl.addEventListener('change', () => {
  onFilterOrSortChanged();
});

sortByEl.addEventListener('change', async () => {
  const shouldReloadFromApi = sortByEl.value === 'vote' || sortByEl.value === 'newest';
  if (shouldReloadFromApi) {
    await loadPapers();
  } else {
    onFilterOrSortChanged();
  }
});

recommendBtn.addEventListener('click', () => {
  requestRecommendationsFromAgent('button');
});

loadPapers();

const appApi = (window as any).yaar?.app;
if (appApi) {
  appApi.register({
    appId: 'recent-papers',
    name: 'Recent Papers',
    state: {
      papers: {
        description: 'Current filtered paper list loaded in the UI',
        handler: () => papers.map((p) => ({
          id: paperId(p),
          title: paperTitle(p),
          summary: paperSummary(p),
          upvotes: getUpvotes(p),
          comments: getComments(p),
        })),
      },

      recommendations: {
        description: 'Current recommended papers',
        handler: () => recommendations,
      },
      paperDetailsCache: {
        description: 'Cached detailed paper data fetched by paper id',
        handler: () => paperDetailsCache,
      },
    },
    commands: {
      refresh: {
        description: 'Reload daily papers from Hugging Face',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await loadPapers();
          return { ok: true, count: papers.length };
        },
      },

      recommendTop2Today: {
        description: 'Ask the AI agent to recommend 2 papers from current context',
        params: { type: 'object', properties: {} },
        handler: async () => {
          if (!sourcePapers.length) {
            await loadPapers();
          }
          requestRecommendationsFromAgent('app-command');
          return { ok: true, queued: true, candidateCount: papers.length };
        },
      },
      fetchPaperDetails: {
        description: 'Fetch detailed summary/content metadata for one paper by id',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        handler: async (p: { id: string }) => {
          const detail = await fetchPaperDetailsById(p.id);
          return { ok: true, detail };
        },
      },
      fetchPaperDetailsBatch: {
        description: 'Fetch detailed summary/content metadata for multiple paper ids',
        params: {
          type: 'object',
          properties: {
            ids: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['ids'],
        },
        handler: async (p: { ids: string[] }) => {
          const ids = Array.isArray(p.ids) ? p.ids.filter(Boolean).slice(0, 20) : [];
          const details = [] as any[];
          for (const id of ids) {
            try {
              details.push(await fetchPaperDetailsById(id));
            } catch (e: any) {
              details.push({ id, error: e?.message || String(e) });
            }
          }
          return { ok: true, count: details.length, details };
        },
      },
      setRecommendations: {
        description: 'Set AI-generated recommendations to display in the UI',
        params: {
          type: 'object',
          properties: {
            recommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  reason: { type: 'string' },
                  upvotes: { type: 'number' },
                  comments: { type: 'number' },
                },
                required: ['id', 'title', 'reason'],
              },
            },
          },
          required: ['recommendations'],
        },
        handler: async (p: { recommendations: Recommendation[] }) => {
          recommendations = (p.recommendations || []).slice(0, 2).map((r) => ({
            id: String(r.id || ''),
            title: String(r.title || 'Untitled paper'),
            reason: String(r.reason || ''),
            upvotes: Number(r.upvotes || 0),
            comments: Number(r.comments || 0),
          }));
          renderRecommendations();
          return { ok: true, count: recommendations.length };
        },
      },
    },
  });
}
