import { getDeck } from '../store';
import { parseAspectRatio } from '../aspect-ratio';
import { escapeHtml } from '../markdown';
import { renderSlideHtml } from '../slide-render';

export function exportPdf() {
  const deck = getDeck();
  const ratio = parseAspectRatio(deck.aspectRatio);
  const htmlStr = `<html><head><title>${escapeHtml(deck.title)}</title><style>
    body{margin:0;font-family:Inter,Arial,sans-serif;}
    .page{page-break-after:always;padding:24px;}
    .slide{width:100%;aspect-ratio:${ratio.cssValue};border-radius:12px;padding:32px;box-sizing:border-box;}
    .slide h1{margin:0 0 12px;font-size:42px;}
    .slide-body{font-size:24px;line-height:1.35;}
    .slide-body p{margin:0 0 10px;}
    .slide-body ul,.slide-body ol{margin:0 0 12px 1.2em;padding:0;}
    .slide-body li{margin:0 0 6px;}
    .slide-body blockquote{margin:8px 0;padding:6px 12px;border-left:4px solid #475569;}
    .slide-body code{font-family:ui-monospace,Menlo,Consolas,monospace;}
    .slide-body pre{margin:10px 0;padding:10px 12px;border-radius:8px;background:rgba(15,23,42,.08);overflow:auto;}
    .slide-body a{color:#1d4ed8;text-decoration:underline;}
    @media print{.page:last-child{page-break-after:auto;}}
  </style></head><body>
    ${deck.slides.map((s) => `<div class="page">${renderSlideHtml(s, deck.themeId, deck.fontSize)}</div>`).join('')}
    <script>window.onload=()=>window.print();<\/script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('Popup blocked. Please allow popups to export PDF.'); return; }
  w.document.open(); w.document.write(htmlStr); w.document.close();
}
