// ---- Styles ----

export function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--yaar-bg);
      color: var(--yaar-text);
      font-size: 14px;
      line-height: 1.5;
    }

    .app-container {
      display: flex;
      height: 100vh;
      overflow: hidden;
    }

    /* Dividers */
    .divider {
      width: 4px;
      background: transparent;
      cursor: col-resize;
      flex-shrink: 0;
      transition: background 0.15s;
      position: relative;
      z-index: 5;
    }

    .divider:hover, .divider.dragging {
      background: var(--yaar-accent);
    }

    /* Sidebar */
    .sidebar {
      background: var(--yaar-bg);
      border-right: 1px solid var(--yaar-border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      flex-shrink: 0;
    }

    .sidebar-header {
      padding: 16px 14px 12px;
      border-bottom: 1px solid var(--yaar-border);
    }

    .app-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--yaar-text);
      letter-spacing: 0.3px;
    }

    .sidebar-section {
      padding: 6px 8px;
    }

    .sidebar-section-label {
      padding: 10px 14px 4px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.8px;
      color: var(--yaar-text-dim);
      text-transform: uppercase;
    }

    .sidebar-feeds {
      flex: 1;
      overflow-y: auto;
      padding: 4px 8px;
      scrollbar-width: thin;
      scrollbar-color: var(--yaar-border) transparent;
    }

    .sidebar-feeds::-webkit-scrollbar { width: 4px; }
    .sidebar-feeds::-webkit-scrollbar-track { background: transparent; }
    .sidebar-feeds::-webkit-scrollbar-thumb { background: var(--yaar-border); border-radius: 2px; }

    .feed-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 8px;
      border-radius: var(--yaar-radius);
      cursor: pointer;
      transition: background 0.15s;
      position: relative;
      user-select: none;
    }

    .feed-item:hover { background: var(--yaar-bg-surface-hover); }
    .feed-item.active { background: var(--yaar-bg-surface); }

    .feed-icon {
      font-size: 13px;
      flex-shrink: 0;
      width: 16px;
      text-align: center;
    }

    .feed-name {
      flex: 1;
      font-size: 13px;
      color: var(--yaar-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .badge {
      background: #238636;
      color: #ffffff;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 10px;
      min-width: 18px;
      text-align: center;
      flex-shrink: 0;
    }

    .feed-remove {
      background: none;
      border: none;
      color: var(--yaar-text-dim);
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 0 2px;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s;
      flex-shrink: 0;
    }

    .feed-item:hover .feed-remove { opacity: 1; }
    .feed-remove:hover { color: var(--yaar-error, #f85149) !important; }

    /* Spinner */
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid var(--yaar-border);
      border-top-color: var(--yaar-accent);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      flex-shrink: 0;
    }

    .spinner-large {
      width: 36px;
      height: 36px;
      border: 3px solid var(--yaar-border);
      border-top-color: var(--yaar-accent);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      margin: 0 auto 16px;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* Add feed */
    .add-feed-section {
      border-top: 1px solid var(--yaar-border);
      padding: 8px 8px 4px;
    }

    .add-feed-form {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 4px 0;
    }

    .feed-url-input, .feed-name-input {
      background: var(--yaar-bg-surface);
      border: 1px solid var(--yaar-border);
      border-radius: var(--yaar-radius);
      color: var(--yaar-text);
      font-size: 12px;
      padding: 6px 8px;
      outline: none;
      transition: border-color 0.15s;
      width: 100%;
    }

    .feed-url-input:focus, .feed-name-input:focus {
      border-color: var(--yaar-accent);
    }

    .feed-url-input::placeholder, .feed-name-input::placeholder {
      color: var(--yaar-text-dim);
    }

    .add-feed-btn {
      background: var(--yaar-accent);
      color: #000;
      border: none;
      border-radius: var(--yaar-radius);
      font-size: 12px;
      font-weight: 600;
      padding: 6px 10px;
      cursor: pointer;
      transition: background 0.15s;
      width: 100%;
    }

    .add-feed-btn:hover { background: var(--yaar-accent-hover); }

    .sidebar-footer {
      padding: 8px;
      border-top: 1px solid var(--yaar-border);
    }

    .refresh-all-btn {
      background: none;
      border: 1px solid var(--yaar-border);
      color: var(--yaar-text-muted);
      border-radius: var(--yaar-radius);
      font-size: 12px;
      padding: 6px 10px;
      cursor: pointer;
      width: 100%;
      transition: all 0.15s;
    }

    .refresh-all-btn:hover {
      border-color: var(--yaar-accent);
      color: var(--yaar-accent);
    }

    /* Article list wrap */
    .article-list-wrap {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      flex-shrink: 0;
    }

    /* Article list */
    .article-list {
      flex: 1;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--yaar-border) transparent;
    }

    .article-list::-webkit-scrollbar { width: 4px; }
    .article-list::-webkit-scrollbar-track { background: transparent; }
    .article-list::-webkit-scrollbar-thumb { background: var(--yaar-border); border-radius: 2px; }

    .article-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--yaar-border);
      cursor: pointer;
      transition: background 0.1s;
      position: relative;
    }

    .article-item:hover { background: var(--yaar-bg-surface-hover); }
    .article-item.selected { background: var(--yaar-bg-surface); }

    .article-thumb {
      width: 56px;
      height: 56px;
      object-fit: cover;
      border-radius: 4px;
      flex-shrink: 0;
      background: var(--yaar-border);
    }

    .article-meta {
      flex: 1;
      min-width: 0;
    }

    .article-source {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
    }

    .source-name {
      font-size: 11px;
      color: var(--yaar-accent);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .pub-date {
      font-size: 11px;
      color: var(--yaar-text-dim);
    }

    .article-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--yaar-text);
      line-height: 1.4;
      margin-bottom: 4px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .article-item.read .article-title {
      color: var(--yaar-text-muted);
      font-weight: 400;
    }

    .article-desc {
      font-size: 11px;
      color: var(--yaar-text-muted);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      line-height: 1.5;
    }

    .unread-dot {
      width: 7px;
      height: 7px;
      background: var(--yaar-accent);
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 6px;
    }

    /* Content area */
    .content-area {
      flex: 1;
      overflow-y: auto;
      background: var(--yaar-bg);
      scrollbar-width: thin;
      scrollbar-color: var(--yaar-border) transparent;
    }

    .content-area::-webkit-scrollbar { width: 5px; }
    .content-area::-webkit-scrollbar-track { background: transparent; }
    .content-area::-webkit-scrollbar-thumb { background: var(--yaar-border); border-radius: 2px; }

    /* Panel header (above article list + content) */
    .main-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--yaar-bg-surface);
      min-width: 0;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      border-bottom: 1px solid var(--yaar-border);
      background: var(--yaar-bg-surface);
      flex-shrink: 0;
    }

    #panel-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--yaar-text);
    }

    .mark-all-read-btn {
      background: none;
      border: 1px solid var(--yaar-border);
      color: var(--yaar-text-muted);
      border-radius: var(--yaar-radius);
      font-size: 11px;
      padding: 4px 10px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .mark-all-read-btn:hover {
      border-color: var(--yaar-accent);
      color: var(--yaar-accent);
    }

    .panel-body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* States */
    .loading-state, .empty-state, .welcome-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      min-height: 200px;
      text-align: center;
      padding: 24px;
    }

    .empty-icon, .welcome-icon {
      font-size: 40px;
      margin-bottom: 12px;
    }

    .empty-title, .welcome-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--yaar-text);
      margin-bottom: 6px;
    }

    .empty-sub, .welcome-sub {
      font-size: 13px;
      color: var(--yaar-text-muted);
      max-width: 240px;
      line-height: 1.6;
    }

    /* Article View */
    .article-view {
      display: flex;
      flex-direction: column;
      min-height: 100%;
    }

    .article-view-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      border-bottom: 1px solid var(--yaar-border);
      position: sticky;
      top: 0;
      background: var(--yaar-bg);
      z-index: 10;
    }

    .back-btn {
      background: none;
      border: 1px solid var(--yaar-border);
      color: var(--yaar-text-muted);
      border-radius: var(--yaar-radius);
      font-size: 13px;
      padding: 5px 12px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .back-btn:hover {
      border-color: var(--yaar-accent);
      color: var(--yaar-accent);
    }

    .open-external-btn {
      background: var(--yaar-accent);
      color: #000;
      border: none;
      border-radius: var(--yaar-radius);
      font-size: 12px;
      font-weight: 600;
      padding: 5px 12px;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s;
    }

    .open-external-btn:hover { background: var(--yaar-accent-hover); }

    .article-view-body {
      padding: 28px 32px;
      max-width: 740px;
    }

    .article-view-source {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      color: var(--yaar-text-muted);
      margin-bottom: 10px;
    }

    .author-sep { color: var(--yaar-text-dim); }

    .article-view-title {
      font-size: 22px;
      font-weight: 700;
      color: var(--yaar-text);
      line-height: 1.35;
      margin-bottom: 16px;
    }

    .article-view-thumb {
      width: 100%;
      max-height: 300px;
      object-fit: cover;
      border-radius: var(--yaar-radius-lg);
      margin-bottom: 20px;
    }

    .article-view-content {
      font-size: 15px;
      line-height: 1.75;
      color: var(--yaar-text);
    }

    .article-view-content p {
      margin-bottom: 14px;
    }

    .article-view-content a {
      color: var(--yaar-accent);
      text-decoration: underline;
    }

    .article-view-content a:hover {
      color: var(--yaar-accent-hover);
    }

    .article-view-content img {
      max-width: 100%;
      height: auto;
      border-radius: var(--yaar-radius);
      margin: 10px 0;
    }

    .article-view-content h1, .article-view-content h2, .article-view-content h3 {
      color: var(--yaar-text);
      margin: 18px 0 8px;
      line-height: 1.3;
    }

    .article-view-content blockquote {
      border-left: 3px solid var(--yaar-accent);
      padding-left: 14px;
      color: var(--yaar-text-muted);
      margin: 14px 0;
    }

    .article-view-content pre, .article-view-content code {
      background: var(--yaar-bg-surface);
      border-radius: 4px;
      padding: 2px 6px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 13px;
    }

    .article-view-content pre {
      padding: 12px;
      overflow-x: auto;
    }

    .article-view-footer {
      margin-top: 32px;
      padding-top: 20px;
      border-top: 1px solid var(--yaar-border);
    }

    .read-more-link {
      color: var(--yaar-accent);
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
    }

    .read-more-link:hover {
      text-decoration: underline;
      color: var(--yaar-accent-hover);
    }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 10px 16px;
      border-radius: var(--yaar-radius);
      font-size: 13px;
      font-weight: 500;
      z-index: 9999;
      opacity: 1;
      transition: opacity 0.4s;
      pointer-events: none;
    }

    .toast-info { background: var(--yaar-bg-surface); color: var(--yaar-text); border: 1px solid var(--yaar-border); }
    .toast-error { background: #2d0f0f; color: var(--yaar-error, #f85149); border: 1px solid var(--yaar-error, #f85149); }
    .toast-success { background: #0d2d18; color: var(--yaar-success, #3fb950); border: 1px solid var(--yaar-success, #3fb950); }
    .toast-fade { opacity: 0; }

    /* Scrollbar for content */
    * { scrollbar-width: thin; scrollbar-color: var(--yaar-border) transparent; }
  `;
  document.head.appendChild(style);
}
