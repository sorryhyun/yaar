export const APP_HTML = `
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
    input, button, select {
      background: #202838; color: var(--text); border: 1px solid var(--border);
      border-radius: 10px; padding: 8px 10px; font: inherit;
    }
    button { cursor: pointer; }
    button:hover { border-color: #3b4660; }
    input { min-width: 270px; }
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
    .links { margin-top: 10px; display:flex; gap:10px; flex-wrap: wrap; }
    .links a { color: var(--accent); font-size: 13px; text-decoration: none; }
    .links a:hover { text-decoration: underline; }
    .tag { display:inline-block; padding:2px 8px; border:1px solid var(--border); border-radius:99px; font-size:11px; }
    .empty { padding: 24px; text-align:center; border: 1px dashed var(--border); border-radius: 12px; color: var(--muted); }
    @media (max-width: 760px) {
      .card-inner { grid-template-columns: 1fr; }
      .content { padding: 0 12px 12px 12px; }
      .thumb { min-height: 180px; }
      input { min-width: 100%; }
    }
  </style>
  <div class="wrap">
    <div class="top">
      <h1>📚 Recent Papers</h1>
      <span class="muted">Sources: Hugging Face + arXiv</span>
      <div class="spacer"></div>

      <label class="muted" for="sourceMode">Source</label>
      <select id="sourceMode">
        <option value="huggingface" selected>Hugging Face</option>
        <option value="arxiv">arXiv</option>
        <option value="both">Both</option>
      </select>

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

      <input id="arxivQuery" value="cat:cs.AI OR cat:cs.LG" placeholder="arXiv query (e.g. all:transformer OR cat:cs.AI)" />

      <button id="recommend2" class="recommend-btn">Recommend 2 papers</button>
      <button id="refresh">Refresh</button>
    </div>
    <div id="status" class="muted">Loading…</div>
    <div id="recommendations" class="recommend-box"></div>
    <div id="list" class="grid" style="margin-top:10px"></div>
  </div>
`;
