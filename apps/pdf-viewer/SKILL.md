# PDF Viewer

A desktop PDF utility app.

## Features
- Open and read PDF files from local upload/drag-drop
- Open PDFs from YAAR storage path
- Export text/HTML content to PDF (via print dialog → Save as PDF)
- Save generated HTML snapshots to storage

## Usage
1. Use **PDF Viewer** tab to open a PDF file.
2. Use **Export to PDF** tab to paste/write content.
3. Click **Export PDF** and choose **Save as PDF** in print dialog.

## Launch
Open this app in an iframe window:
```
create({
  windowId: "pdf-viewer",
  title: "PDF Viewer",
  renderer: "iframe",
  content: "/api/apps/pdf-viewer/static/index.html"
})
```

## Source
Source code is available in `src/` directory. Use `read_config` with path `src/main.ts` to view.
