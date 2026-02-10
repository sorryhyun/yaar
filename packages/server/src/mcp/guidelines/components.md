# Component DSL Guide

Components are a **flat array** laid out with CSS grid. No recursive trees — this keeps things simple for LLMs.

## Layout

- `cols` — number for equal columns (e.g., `2`), array for ratio (e.g., `[7, 3]` = 70/30 split). Default: `1`.
- `gap` — spacing between components: `"none"`, `"sm"`, `"md"` (default), `"lg"`.
- Components fill grid cells left-to-right, top-to-bottom. Use `colSpan` on a component to span multiple columns.

Prefer multi-column layouts (`cols: 2` or ratio like `[7, 3]`) for richer UIs; use 1 column only for simple single-component windows.

## Example

2-column layout with 7:3 ratio:
```json
{
  "cols": [7, 3],
  "components": [
    { "type": "text", "content": "Name", "variant": "caption" },
    { "type": "badge", "label": "Active", "variant": "success" },
    { "type": "input", "name": "query", "formId": "f1", "placeholder": "Search..." },
    { "type": "button", "label": "Go", "action": "search", "submitForm": "f1" }
  ]
}
```

## Loading from File

You can provide components inline OR load from a `.yaarcomponent.json` file via the `jsonfile` param (e.g., `jsonfile: "myapp/dashboard.yaarcomponent.json"`). The path is relative to `apps/`.
