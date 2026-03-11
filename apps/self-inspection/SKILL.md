# Self Inspection (Verb Mode)

A deep diagnostic suite that stress-tests YAAR's verb layer — identical coverage to Self Inspection but using **only the 5 generic verbs** (`describe`, `read`, `list`, `invoke`, `delete`) against `yaar://` URIs.

## Launch

This is a pure-skill app — no iframe or compiled code. Follow the instructions below using verb tools directly.

When the user opens this app or says "run verb inspection", "run verb diagnostics", or "verb self-test", run all checks below and produce the report.

**Important:** Verb mode must be enabled (`verbMode: true` in settings). If it's not, enable it first:
```
invoke('yaar://config/settings', { verbMode: true })
```

---

## Diagnostics

### 1. Describe & Discovery

Test that `describe` returns valid schemas for key resources across multiple domains:

```
describe('yaar://config/settings')
describe('yaar://storage')
describe('yaar://sessions/current/monitors')
describe('yaar://sessions/current/notifications')
describe('yaar://apps')
describe('yaar://sessions/current/agents')
describe('yaar://sessions/current')
```

**PASS** if all 7 describe calls return verbs arrays and descriptions without errors.

### 2. Session Root & Namespace Listing

Test the root resource and namespace enumeration:

```
read('yaar://')                    # should return session overview (sessionId, platform, etc.)
list('yaar://')                    # should return all 9 URI namespaces
list('yaar://config/')             # should return config sections (settings, hooks, shortcuts, mounts, app)
```

**PASS** if root read returns session info and both list calls return expected items.

### 3. Concurrent Multi-Renderer Windows

Open 5 windows simultaneously using different renderers via `invoke`, verify all exist via `list`, then close all via `delete`:

```
invoke('yaar://windows/si-v-md', { action: "create", title: "Test: Markdown", width: 300, height: 200, renderer: "markdown", content: "# Markdown\n\n**Bold** and *italic*." })
invoke('yaar://windows/si-v-html', { action: "create", title: "Test: HTML", width: 300, height: 200, renderer: "html", content: "<div style='padding:16px'><h2>HTML</h2><p style='color:green'>Styled content.</p></div>" })
invoke('yaar://windows/si-v-text', { action: "create", title: "Test: Text", width: 300, height: 200, renderer: "text", content: "Plain text content.\nLine 2.\nLine 3." })
invoke('yaar://windows/si-v-comp', { action: "create_component", title: "Test: Component", width: 300, height: 200, components: [{ "type": "text", "content": "Component DSL", "variant": "heading" }, { "type": "badge", "label": "OK", "variant": "success" }, { "type": "progress", "value": 75, "label": "Progress" }] })
invoke('yaar://windows/si-v-tbl', { action: "create", title: "Test: Table", width: 300, height: 200, renderer: "table", content: { "headers": ["Col A", "Col B"], "rows": [["1", "2"], ["3", "4"]] } })
```

Verify:
```
list('yaar://sessions/current/monitors')   # all 5 windows should appear: si-v-md, si-v-html, si-v-text, si-v-comp, si-v-tbl
```

**PASS** if all 5 windows appear in the list. Then close all:
```
delete('yaar://windows/si-v-md')
delete('yaar://windows/si-v-html')
delete('yaar://windows/si-v-text')
delete('yaar://windows/si-v-comp')
delete('yaar://windows/si-v-tbl')
```

### 4. Window Content Update Operations

Create a markdown window and test all update operations via invoke:

```
invoke('yaar://windows/si-v-update', { action: "create", title: "Update Test", renderer: "markdown", content: "Line 1" })
invoke('yaar://windows/si-v-update', { action: "update", operation: "append", content: "\nLine 2" })
read('yaar://windows/si-v-update')          # should contain "Line 1\nLine 2"
invoke('yaar://windows/si-v-update', { action: "update", operation: "prepend", content: "Line 0\n" })
read('yaar://windows/si-v-update')          # should contain "Line 0\nLine 1\nLine 2"
invoke('yaar://windows/si-v-update', { action: "update", operation: "replace", content: "Replaced." })
read('yaar://windows/si-v-update')          # should contain only "Replaced."
delete('yaar://windows/si-v-update')
```

**PASS** if each `read` returns the expected content after each operation.

### 5. Window Lock/Unlock

```
invoke('yaar://windows/si-v-lock', { action: "create", title: "Lock Test", renderer: "text", content: "Locked window test." })
invoke('yaar://windows/si-v-lock', { action: "lock" })
```
Attempt to update the locked window — it should return a lock error or feedback:
```
invoke('yaar://windows/si-v-lock', { action: "update", operation: "replace", content: "Should fail." })
```
Then unlock and update successfully:
```
invoke('yaar://windows/si-v-lock', { action: "unlock" })
invoke('yaar://windows/si-v-lock', { action: "update", operation: "replace", content: "Unlocked and updated." })
read('yaar://windows/si-v-lock')            # should contain "Unlocked and updated."
delete('yaar://windows/si-v-lock')
```

**PASS** if locked update is rejected and unlocked update succeeds.

### 6. Component Form Submission (interactive)

Create a component window with a form and ask the user to fill it:

```
invoke('yaar://windows/si-v-form', {
  action: "create_component",
  title: "Form Test",
  width: 400, height: 300,
  components: [
    { "type": "text", "content": "Fill out this form and click Submit.", "variant": "heading" },
    { "type": "input", "name": "username", "formId": "test-form", "label": "Username", "placeholder": "Enter anything" },
    { "type": "select", "name": "color", "formId": "test-form", "label": "Favorite Color", "options": [{ "value": "red", "label": "Red" }, { "value": "blue", "label": "Blue" }, { "value": "green", "label": "Green" }] },
    { "type": "input", "name": "notes", "formId": "test-form", "label": "Notes", "placeholder": "Optional", "rows": 2 },
    { "type": "button", "label": "Submit", "submitForm": "test-form", "action": "form-submitted", "variant": "primary" }
  ]
})
```

Tell the user: "Please fill out the form and click **Submit**."
When you receive the `COMPONENT_ACTION` event with form data, read the submitted values and close the window.
**PASS** if form data is received with `username` and `color` fields.
```
delete('yaar://windows/si-v-form')
```

### 7. App Protocol Round-Trip (Excel)

Open Excel Lite, query its manifest, write cells, read them back, verify data integrity:

```
invoke('yaar://windows/si-v-excel', { action: "create", title: "Excel Lite", appId: "excel-lite", renderer: "iframe", content: "yaar://apps/excel-lite" })
```

Wait for App Protocol ready, then query manifest:
```
invoke('yaar://windows/si-v-excel', { action: "app_query" })
```
Verify manifest contains `setCells` command and `cells` state key.

Write test data:
```
invoke('yaar://windows/si-v-excel', { action: "app_command", command: "setCells", params: { "cells": { "A1": "Name", "B1": "Score", "A2": "Alice", "B2": "95", "A3": "Bob", "B3": "87" } } })
```

Read back:
```
invoke('yaar://windows/si-v-excel', { action: "app_query", stateKey: "cells" })
```
Verify cells A1="Name", B1="Score", A2="Alice", B2="95", A3="Bob", B3="87".

Test clearRange:
```
invoke('yaar://windows/si-v-excel', { action: "app_command", command: "clearRange", params: { "start": "A3", "end": "B3" } })
invoke('yaar://windows/si-v-excel', { action: "app_query", stateKey: "cells" })
```
Verify A3 and B3 are now empty/missing, but A1-B2 still intact.

```
delete('yaar://windows/si-v-excel')
```

**PASS** if all read-back values match expectations.

### 8. App Protocol Round-Trip (Word)

Open Word Lite, set content, read it back:

```
invoke('yaar://windows/si-v-word', { action: "create", title: "Word Lite", appId: "word-lite", renderer: "iframe", content: "yaar://apps/word-lite" })
```

Wait for ready, then:
```
invoke('yaar://windows/si-v-word', { action: "app_command", command: "setTitle", params: { "title": "Self Inspection Test" } })
invoke('yaar://windows/si-v-word', { action: "app_command", command: "setContent", params: { "content": "<h1>Test Document</h1><p>This is a self-inspection test.</p>", "renderer": "html" } })
invoke('yaar://windows/si-v-word', { action: "app_query", stateKey: "title" })   # should be "Self Inspection Test"
invoke('yaar://windows/si-v-word', { action: "app_query", stateKey: "stats" })    # should have words > 0
invoke('yaar://windows/si-v-word', { action: "app_query", stateKey: "text" })     # should contain "self-inspection test"
delete('yaar://windows/si-v-word')
```

**PASS** if title, stats, and text match expectations.

### 9. Cross-App Data Flow (Storage → Excel)

Write structured data to storage via invoke, then import it into Excel via App Protocol:

```
invoke('yaar://storage/_si-v-test-data.json', { action: "write", content: "{\"cells\":{\"A1\":\"Product\",\"B1\":\"Price\",\"A2\":\"Widget\",\"B2\":\"9.99\",\"A3\":\"Gadget\",\"B3\":\"24.50\"},\"styles\":{\"A1\":{\"bold\":true},\"B1\":{\"bold\":true}}}" })
read('yaar://storage/_si-v-test-data.json')     # verify JSON is readable
```

Open Excel and import:
```
invoke('yaar://windows/si-v-cross', { action: "create", title: "Cross-App Test", appId: "excel-lite", renderer: "iframe", content: "yaar://apps/excel-lite" })
```

Wait for ready, then import the data you read from storage:
```
invoke('yaar://windows/si-v-cross', { action: "app_command", command: "importWorkbook", params: { "data": <parsed JSON from storage read> } })
invoke('yaar://windows/si-v-cross', { action: "app_query", stateKey: "cells" })
```
Verify A1="Product", B2="9.99".

Cleanup:
```
delete('yaar://windows/si-v-cross')
delete('yaar://storage/_si-v-test-data.json')
```

**PASS** if imported data matches the original JSON.

### 10. Dev Pipeline (Write → Compile → Deploy → Verify → Cleanup)

Test the full app development pipeline using verb-based sandbox operations.

**Step 1 — Write source:**
```
invoke('yaar://sandbox/new/src/main.ts', { action: "write", content: "import html from '@bundled/solid-js/html';\nimport { render } from '@bundled/solid-js/web';\n\nrender(() => html\`<div><h1 id=\"si-v-test\">Verb Inspection Dev Test</h1><p>Compiled and deployed successfully.</p></div>\`, document.getElementById('app')!);" })
```
Record the returned `sandboxId`.

**Step 2 — Compile via verb:**
```
invoke('yaar://sandbox/<sandboxId>', { action: "compile" })
```
**PASS (compile)** if `previewUrl` is returned.

**Step 3 — Deploy via verb:**
```
invoke('yaar://sandbox/<sandboxId>', { action: "deploy", appId: "si-v-dev-test", name: "SI Verb Dev Test", icon: "🧪", description: "Temporary test app from verb self-inspection" })
```
**PASS (deploy)** if deploy succeeds without error.

**Step 4 — Verify deployment:**
```
list('yaar://apps')
```
Verify "si-v-dev-test" appears in the app list.

**Step 5 — Open and verify:**
```
invoke('yaar://windows/si-v-dev-verify', { action: "create", title: "Dev Test Verify", appId: "si-v-dev-test", renderer: "iframe", content: "yaar://apps/si-v-dev-test" })
list('yaar://monitors')    # verify window exists
delete('yaar://windows/si-v-dev-verify')
```

**Step 6 — Cleanup (delete the test app):**
```
delete('yaar://apps/si-v-dev-test')
```
Verify it no longer appears in the app list.

**PASS** if all 6 steps complete successfully.

### 11. Sandbox Stress Tests

Run multiple sandbox executions testing edge cases via `yaar://sandbox/eval`.

**11a — Async/await:**
```
invoke('yaar://sandbox/eval', { code: "const r = await fetch('http://localhost:8000/health').then(r=>r.json()); JSON.stringify(r)" })
```
**PASS** if returns `{"status":"ok"}`.

**11b — Computation:**
```
invoke('yaar://sandbox/eval', { code: "let sum = 0; for (let i = 0; i < 1000000; i++) sum += i; JSON.stringify({ sum })" })
```
**PASS** if returns `{"sum":499999500000}`.

**11c — Error handling:**
```
invoke('yaar://sandbox/eval', { code: "throw new Error('intentional test error')" })
```
**PASS** if error is caught and reported (not a crash).

**11d — Crypto:**
```
invoke('yaar://sandbox/eval', { code: "const hash = crypto.createHash('sha256').update('self-inspection').digest('hex'); hash" })
```
**PASS** if returns a 64-character hex string.

**11e — Multiple return types:**
```
invoke('yaar://sandbox/eval', { code: "JSON.stringify({ string: 'hello', number: 42, bool: true, array: [1,2,3], nested: { a: 1 } })" })
```
**PASS** if all types are preserved in the output.

### 12. Shortcut Create/Delete via Config URI

```
invoke('yaar://config/shortcuts', { label: "SI Verb Test", icon: "🧪", shortcutType: "action", target: "self-inspection test" })
read('yaar://config/shortcuts')     # verify shortcut appears, note the shortcutId
delete('yaar://config/shortcuts/<the-shortcut-id>')
read('yaar://config/shortcuts')     # verify it's gone
```

**PASS** if shortcut appears after create and disappears after remove.

### 13. Component Update

Create a component window, then replace its entire layout:

```
invoke('yaar://windows/si-v-comp-upd', {
  action: "create_component",
  title: "Component Update Test",
  width: 350, height: 200,
  components: [
    { "type": "text", "content": "Version 1", "variant": "heading" },
    { "type": "progress", "value": 25, "label": "Progress" }
  ]
})
```

Update the components:
```
invoke('yaar://windows/si-v-comp-upd', {
  action: "update_component",
  components: [
    { "type": "text", "content": "Version 2", "variant": "heading" },
    { "type": "progress", "value": 100, "label": "Complete", "variant": "success" },
    { "type": "badge", "label": "Updated", "variant": "info" }
  ]
})
```

```
delete('yaar://windows/si-v-comp-upd')
```

**PASS** if update_component succeeds without error.

### 14. Storage Directory Operations via URI

Test directory creation and listing:

```
invoke('yaar://storage/_si-v-test-dir/file1.txt', { action: "write", content: "File 1" })
invoke('yaar://storage/_si-v-test-dir/file2.txt', { action: "write", content: "File 2" })
invoke('yaar://storage/_si-v-test-dir/sub/file3.txt', { action: "write", content: "File 3" })
list('yaar://storage/_si-v-test-dir')           # should show file1.txt, file2.txt, sub/
list('yaar://storage/_si-v-test-dir/sub')       # should show file3.txt
delete('yaar://storage/_si-v-test-dir/file1.txt')
delete('yaar://storage/_si-v-test-dir/file2.txt')
delete('yaar://storage/_si-v-test-dir/sub/file3.txt')
```

**PASS** if directory listing shows expected files and subdirectory.

### 15. Multi-App Simultaneous

Open 3 App Protocol apps simultaneously and interact with all of them:

```
invoke('yaar://windows/si-v-multi-excel', { action: "create", title: "Multi: Excel", appId: "excel-lite", renderer: "iframe", content: "yaar://apps/excel-lite" })
invoke('yaar://windows/si-v-multi-word', { action: "create", title: "Multi: Word", appId: "word-lite", renderer: "iframe", content: "yaar://apps/word-lite" })
invoke('yaar://windows/si-v-multi-img', { action: "create", title: "Multi: Images", appId: "image-viewer", renderer: "iframe", content: "yaar://apps/image-viewer" })
```

Wait for all 3 to be ready, then interact with each:

```
invoke('yaar://windows/si-v-multi-excel', { action: "app_command", command: "setCells", params: { "cells": { "A1": "Multi-app test" } } })
invoke('yaar://windows/si-v-multi-word', { action: "app_command", command: "setContent", params: { "content": "<p>Multi-app test</p>", "renderer": "html" } })
invoke('yaar://windows/si-v-multi-img', { action: "app_command", command: "setLayout", params: { "mode": "grid", "columns": 3 } })
```

Query each to verify:
```
invoke('yaar://windows/si-v-multi-excel', { action: "app_query", stateKey: "cells" })    # A1 = "Multi-app test"
invoke('yaar://windows/si-v-multi-word', { action: "app_query", stateKey: "text" })      # contains "Multi-app test"
invoke('yaar://windows/si-v-multi-img', { action: "app_query", stateKey: "layout" })     # mode = "grid"
```

Close all:
```
delete('yaar://windows/si-v-multi-excel')
delete('yaar://windows/si-v-multi-word')
delete('yaar://windows/si-v-multi-img')
```

**PASS** if all 3 apps respond correctly to commands and queries simultaneously.

### 16. Monitor-as-Resource

Read the monitor resource to verify it returns status:

```
read('yaar://sessions/current/monitors')
```

**PASS** if returns monitorId, hasMainAgent, windows list, and stats.

### 17. Agents Discovery

List and inspect active agents:

```
list('yaar://sessions/current/agents')
```

If agents are listed, read one:
```
read('yaar://sessions/current/agents/<first-agent-id>')
```

**PASS** if agent list returns without error and (if agents exist) individual agent read returns agent info.

### 18. User Notifications via URI

Test notification lifecycle through verb layer:

```
invoke('yaar://sessions/current/notifications', { title: "Verb Test", body: "Self-inspection notification test", variant: "info" })
```

**PASS** if notification is shown without error.

---

## Report Format

After all checks, create a markdown window with the results:

```
invoke('yaar://windows/self-inspection-report', {
  action: "create",
  title: "Self Inspection Report (Verb Mode)",
  width: 750, height: 750,
  renderer: "markdown",
  content: "# Self Inspection Report (Verb Mode)\n\n| # | Check | Status | Details |\n|---|-------|--------|---------|\n| 1 | Describe & Discovery | PASS | 7/7 resources described |\n| 2 | Session Root & Namespaces | PASS | root read + 2 list calls verified |\n| 3 | Multi-Renderer Windows | PASS | 5/5 renderers created |\n| 4 | Content Updates | PASS | append/prepend/replace verified |\n| 5 | Window Lock/Unlock | PASS | lock rejected update, unlock allowed |\n| 6 | Form Submission | PASS | received username, color fields |\n| 7 | App Protocol (Excel) | PASS | setCells/query/clearRange verified |\n| 8 | App Protocol (Word) | PASS | setContent/title/stats verified |\n| 9 | Cross-App Data Flow | PASS | storage → excel import verified |\n| 10 | Dev Pipeline | PASS | write → compile → deploy → cleanup |\n| 11 | Sandbox Stress | PASS | 5/5 subtests passed |\n| 12 | Shortcuts via Config URI | PASS | create/list/remove verified |\n| 13 | Component Update | PASS | layout replaced successfully |\n| 14 | Storage Directories | PASS | nested dirs and listing verified |\n| 15 | Multi-App Simultaneous | PASS | 3 apps commanded simultaneously |\n| 16 | Monitor-as-Resource | PASS | monitor status returned |\n| 17 | Agents Discovery | PASS | agent list/read verified |\n| 18 | User Notifications | PASS | notification shown |\n\n**Result: X/18 checks passed**\n\n### Verb Coverage\n| Verb | Tested In |\n|------|-----------|\n| describe | #1 |\n| read | #2, #4, #5, #16, #17 |\n| list | #2, #3, #10, #14, #17 |\n| invoke | #3–#15, #18 |\n| delete | #3–#5, #9, #10, #12, #14, #15 |"
})
```

Mark each check as:
- **PASS** — expected result received
- **FAIL** — unexpected result or error (include error message in Details)
- **SKIP** — could not run (explain why in Details)

## Cleanup Guarantee

If any test fails partway through, always attempt cleanup (close windows, delete test files, remove test apps). Never leave test artifacts behind. Window IDs used by this inspection all start with `si-v-` for easy identification.

## Verb Coverage Notes

All diagnostics use the 5 generic verbs exclusively. Dev tools (compile, typecheck, deploy, clone) are available via `invoke('yaar://sandbox/{id}', { action: "..." })`. Sandboxed JS execution uses `invoke('yaar://sandbox/eval', { code: "..." })`.
