export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sanitizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

function renderInlineMarkdown(raw: string): string {
  const tokens: string[] = [];
  const token = (html: string) => {
    tokens.push(html);
    return `@@TOK${tokens.length - 1}@@`;
  };

  let working = raw
    .replace(/`([^`\n]+)`/g, (_m, code: string) => token(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_m, text: string, href: string) => {
      const safeHref = sanitizeUrl(href);
      if (!safeHref) return token(escapeHtml(text));
      return token(
        `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`,
      );
    });

  working = escapeHtml(working)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>');

  return working.replace(/@@TOK(\d+)@@/g, (_m, idx: string) => tokens[Number(idx)] ?? '');
}

function containsMarkdownSyntax(text: string): boolean {
  return /(^#{1,6}\s)|(^>\s)|(^\s*[-*+]\s)|(^\s*\d+\.\s)|(\*\*)|(\*)|(`)|\[[^\]]+\]\([^\)]+\)|(^```)|(^---\s*$)/m.test(
    text,
  );
}

export function renderBodyContent(raw: string): string {
  const text = raw || '';
  if (!containsMarkdownSyntax(text)) {
    return `<p>${escapeHtml(text).replaceAll('\n', '<br/>')}</p>`;
  }

  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  let inCode = false;
  let codeLines: string[] = [];

  const closeLists = () => {
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      out.push('</ol>');
      inOl = false;
    }
  };

  const flushCode = () => {
    if (!inCode) return;
    out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    inCode = false;
    codeLines = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      closeLists();
      if (inCode) {
        flushCode();
      } else {
        inCode = true;
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeLists();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        out.push('<ul>');
        inUl = true;
      }
      out.push(`<li>${renderInlineMarkdown(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ol) {
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        out.push('<ol>');
        inOl = true;
      }
      out.push(`<li>${renderInlineMarkdown(ol[1])}</li>`);
      continue;
    }

    if (/^---\s*$/.test(line)) {
      closeLists();
      out.push('<hr/>');
      continue;
    }

    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      closeLists();
      out.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    closeLists();
    out.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }

  closeLists();
  flushCode();

  return out.length ? out.join('') : '<p></p>';
}
