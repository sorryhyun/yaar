# Component DSL Guide

Components are a **flat array** laid out with CSS grid. No recursive trees — this keeps things simple for LLMs.

**There are no containers.** A component never holds other components (no `row`, `column`, `card`, `group`, …), and only the types below exist. A layout with an unknown type or a nested `components` array is rejected with an error naming the entry.

## Layout

- `cols` — number for equal columns (e.g., `2`), array for ratio (e.g., `[7, 3]` = 70/30 split). Default: `1`.
- `gap` — spacing between components: `"none"`, `"sm"`, `"md"` (default), `"lg"`.
- Components fill grid cells left-to-right, top-to-bottom, one component per cell. For a row of buttons, set `cols` to the number of buttons.

Prefer multi-column layouts (`cols: 2` or ratio like `[7, 3]`) for richer UIs; use 1 column only for simple single-component windows.

## Component Types

| `type` | Required | Optional |
|---|---|---|
| `text` | `content` | `variant`: body, heading, subheading, caption, code · `color`: default, muted, accent, success, warning, error · `textAlign`: left, center, right |
| `button` | `label`, `action` (message sent to you on click) | `variant`: primary, secondary, ghost, danger · `size`: sm, md, lg · `disabled` · `icon` (emoji or short text before the label) · `submitForm` (form id whose fields ride along) · `parallel` (default true) |
| `badge` | `label` | `variant`: default, success, warning, error, info |
| `progress` | `value` (0–100) | `label` · `variant`: default, success, warning, error · `showValue` |
| `image` | `src` | `width`, `height` (px number or CSS value) · `fit`: contain, cover, fill |
| `input` | `name` | `formId` · `label` · `placeholder` · `defaultValue` · `variant`: text, email, password, number, url · `rows` (renders a textarea) · `disabled` |
| `select` | `name`, `options` (`[{ value, label }]`) | `formId` · `label` · `placeholder` · `defaultValue` · `disabled` |

`text` is plain text — it does not render markdown. For long or formatted prose (headings, lists, tables, links), open a separate `renderer: "markdown"` window and keep the component window for the controls.

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

## Creating and Updating

Create a component window using `action: "create"` with `renderer: "component"`. The `content` field is the layout object:
```
invoke('yaar://windows/', { action: "create", title: "Dashboard", renderer: "component", content: { cols: [7, 3], components: [...] } })
```

To change it, `update` with `operation: "replace"` and the full layout as `content` — `append`/`prepend`/`insertAt` do not apply to component windows.

Alternatively, load from a `.yaarcomponent.json` file via the `jsonfile` param (e.g., `jsonfile: "myapp/dashboard.yaarcomponent.json"`). The path is relative to `apps/`.
