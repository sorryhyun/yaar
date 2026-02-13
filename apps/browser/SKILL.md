# Browser

Visible browser automation tool. Playwright runs server-side; you control it via `browser_*` tools and the user watches live in a YAAR window.

## When to Use

- **Use browser tools** for JS-rendered pages, login flows, form filling, multi-step interactions, or any page that requires a real browser.
- **Use `http_get`/`http_post`** for simple API calls, static pages, or when you just need raw HTML/JSON.

## Tools

| Tool | Purpose |
|------|---------|
| `browser_open(url)` | Navigate to URL — opens a browser window on the desktop |
| `browser_click(selector?, text?)` | Click an element by CSS selector or visible text |
| `browser_type(selector, text)` | Type into an input field |
| `browser_press(key)` | Press a keyboard key (Enter, Tab, Escape, etc.) |
| `browser_scroll(direction)` | Scroll up or down |
| `browser_screenshot()` | Get current screenshot as image (for visual inspection) |
| `browser_extract(selector?)` | Extract page text, links, and form fields |
| `browser_close()` | Close the browser and its window |

## Workflow Pattern

```
1. browser_open(url)         → Navigate, see page state
2. browser_extract()         → Get structured content (text, links, forms)
3. browser_click/type/press  → Interact with the page
4. browser_extract()         → Verify result
5. browser_close()           → Clean up when done
```

## Best Practices

- Always call `browser_extract()` after navigation to understand the page structure before interacting.
- Use `browser_screenshot()` when text extraction isn't enough to understand the visual layout.
- Prefer CSS selectors for `browser_click` when possible; fall back to `text` for buttons/links with visible labels.
- The browser window shows live screenshots — the user can see what you're doing.
- If the user clicks the browser window, you'll receive a user takeover message — stop automating and ask what they want.
- Close the browser when you're done to free resources.
- The domain must be in the allowed list (use `request_allowing_domain` first if needed).

## App Protocol

This is a hidden app with `appProtocol: true`. The browser tools manage the window automatically — you don't need to use `app_query`/`app_command` directly.

### Commands (used internally by browser tools)
- `refresh({ url, title })` — Update URL bar and reload screenshot
- `clear()` — Clear the display
