export const styles = `
:root {
  --bg: #0f172a;
  --panel: #111827;
  --toolbar: #1f2937;
  --surface: #ffffff;
  --text: #111827;
  --muted: #6b7280;
  --accent: #2563eb;
  --border: #e5e7eb;
}

* { box-sizing: border-box; }
html, body {
  margin: 0;
  height: 100%;
  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  background: var(--bg);
}

#app {
  height: 100%;
}

.app-shell {
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  height: 100%;
  color: #e5e7eb;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--panel);
  border-bottom: 1px solid #374151;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
}

.brand-badge {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: linear-gradient(135deg, #3b82f6, #1d4ed8);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 13px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  background: var(--toolbar);
  border-bottom: 1px solid #374151;
}

.group {
  display: inline-flex;
  gap: 6px;
  padding-right: 8px;
  margin-right: 4px;
  border-right: 1px solid #374151;
}

.group:last-child {
  border-right: 0;
  padding-right: 0;
}

button, select {
  border: 1px solid #4b5563;
  background: #111827;
  color: #f3f4f6;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
}

button:hover, select:hover {
  border-color: #9ca3af;
}

button.primary {
  background: var(--accent);
  border-color: #1e40af;
}

.editor-wrap {
  overflow: auto;
  padding: 24px;
  background: #0b1220;
}

.page {
  max-width: 860px;
  min-height: calc(100% - 4px);
  margin: 0 auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 24px rgba(0,0,0,0.22);
  color: var(--text);
  padding: 36px 44px;
  outline: none;
  line-height: 1.5;
  font-size: 16px;
  cursor: text;
}

.page a,
.page a:link,
.page a:visited,
.page a:hover,
.page a:active,
.page a:focus,
.page a * {
  cursor: pointer !important;
}

.page a:hover {
  text-decoration: underline;
}

.page:empty:before {
  content: attr(data-placeholder);
  color: #9ca3af;
}

.statusbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--panel);
  border-top: 1px solid #374151;
  color: #d1d5db;
  font-size: 12px;
}

.muted {
  color: var(--muted);
}
`