# Self Inspection

A deep diagnostic suite that stress-tests YAAR's complex subsystems: App Protocol, dev pipeline, concurrent windows, cross-app data flow, and more.

## Launch

This is a pure-skill app — no iframe or compiled code. Follow the instructions below using MCP tools directly.

When the user opens this app or says "run self-inspection", "run diagnostics", or "self-test", run all checks below and produce the report.

If localhost is not in the allowed domains list, use `request_allowing_domain({ domain: "localhost" })` first.

---

## Diagnostics

### 1. Concurrent Multi-Renderer Windows

Open 5 windows simultaneously using different renderers, verify all exist, then close all:

```
create({ windowId: "si-mr-md", title: "Test: Markdown", width: 300, height: 200, content: { renderer: "markdown", content: "# Markdown\n\n**Bold** and *italic*." } })
create({ windowId: "si-mr-html", title: "Test: HTML", width: 300, height: 200, content: { renderer: "html", content: "<div style='padding:16px'><h2>HTML</h2><p style='color:green'>Styled content.</p></div>" } })
create({ windowId: "si-mr-text", title: "Test: Text", width: 300, height: 200, content: { renderer: "text", content: "Plain text content.\nLine 2.\nLine 3." } })
create_component({ windowId: "si-mr-comp", title: "Test: Component", width: 300, height: 200, components: [{ type: "text", content: "Component DSL", variant: "heading" }, { type: "badge", label: "OK", variant: "success" }, { type: "progress", value: 75, label: "Progress" }] })
create({ windowId: "si-mr-tbl", title: "Test: Table", width: 300, height: 200, content: { renderer: "table", content: { headers: ["Col A", "Col B"], rows: [["1", "2"], ["3", "4"]] } } })
```

Then verify:
```
list()   # all 5 windows should appear: si-mr-md, si-mr-html, si-mr-text, si-mr-comp, si-mr-tbl
```

**PASS** if all 5 windows appear in the list. Then close all:
```
close({ windowId: "si-mr-md" })
close({ windowId: "si-mr-html" })
close({ windowId: "si-mr-text" })
close({ windowId: "si-mr-comp" })
close({ windowId: "si-mr-tbl" })
```

### 2. Window Content Update Operations

Create a markdown window and test all update operations:

```
create({ windowId: "si-update", title: "Update Test", content: { renderer: "markdown", content: "Line 1" } })
update({ windowId: "si-update", operation: "append", content: "\nLine 2" })
view({ windowId: "si-update" })          # should contain "Line 1\nLine 2"
update({ windowId: "si-update", operation: "prepend", content: "Line 0\n" })
view({ windowId: "si-update" })          # should contain "Line 0\nLine 1\nLine 2"
update({ windowId: "si-update", operation: "replace", content: "Replaced." })
view({ windowId: "si-update" })          # should contain only "Replaced."
close({ windowId: "si-update" })
```

**PASS** if each `view()` returns the expected content after each operation.

### 3. Window Lock/Unlock

```
create({ windowId: "si-lock", title: "Lock Test", content: { renderer: "text", content: "Locked window test." } })
lock({ windowId: "si-lock" })
```
Attempt to update the locked window — it should return a lock error or feedback:
```
update({ windowId: "si-lock", operation: "replace", content: "Should fail." })
```
Then unlock and update successfully:
```
unlock({ windowId: "si-lock" })
update({ windowId: "si-lock", operation: "replace", content: "Unlocked and updated." })
view({ windowId: "si-lock" })            # should contain "Unlocked and updated."
close({ windowId: "si-lock" })
```

**PASS** if locked update is rejected and unlocked update succeeds.

### 4. Component Form Submission (interactive)

Create a component window with a form and ask the user to fill it:

```
create_component({
  windowId: "si-form",
  title: "Form Test",
  width: 400, height: 300,
  components: [
    { type: "text", content: "Fill out this form and click Submit.", variant: "heading" },
    { type: "input", name: "username", formId: "test-form", label: "Username", placeholder: "Enter anything" },
    { type: "select", name: "color", formId: "test-form", label: "Favorite Color", options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }, { value: "green", label: "Green" }] },
    { type: "input", name: "notes", formId: "test-form", label: "Notes", placeholder: "Optional", rows: 2 },
    { type: "button", label: "Submit", submitForm: "test-form", action: "form-submitted", variant: "primary" }
  ]
})
```

Tell the user: "Please fill out the form and click **Submit**."
When you receive the `COMPONENT_ACTION` event with form data, read the submitted values and close the window.
**PASS** if form data is received with `username` and `color` fields.
```
close({ windowId: "si-form" })
```

### 5. App Protocol Round-Trip (Excel)

Open Excel Lite, query its manifest, write cells, read them back, verify data integrity:

```
create({ windowId: "si-excel", title: "Excel Lite", appId: "excel-lite", content: { renderer: "iframe" } })
```

Wait for App Protocol ready, then:
```
app_query({ windowId: "si-excel", stateKey: "manifest" })
```
Verify manifest contains `setCells` command and `cells` state key.

Write test data:
```
app_command({ windowId: "si-excel", command: "setCells", params: { cells: { "A1": "Name", "B1": "Score", "A2": "Alice", "B2": "95", "A3": "Bob", "B3": "87" } } })
```

Read back:
```
app_query({ windowId: "si-excel", stateKey: "cells" })
```
Verify cells A1="Name", B1="Score", A2="Alice", B2="95", A3="Bob", B3="87".

Test clearRange:
```
app_command({ windowId: "si-excel", command: "clearRange", params: { start: "A3", end: "B3" } })
app_query({ windowId: "si-excel", stateKey: "cells" })
```
Verify A3 and B3 are now empty/missing, but A1-B2 still intact.

```
close({ windowId: "si-excel" })
```

**PASS** if all read-back values match expectations.

### 6. App Protocol Round-Trip (Word)

Open Word Lite, set content, read it back:

```
create({ windowId: "si-word", title: "Word Lite", appId: "word-lite", content: { renderer: "iframe" } })
```

Wait for ready, then:
```
app_command({ windowId: "si-word", command: "setTitle", params: { title: "Self Inspection Test" } })
app_command({ windowId: "si-word", command: "setHtml", params: { html: "<h1>Test Document</h1><p>This is a self-inspection test.</p>" } })
app_query({ windowId: "si-word", stateKey: "title" })   # should be "Self Inspection Test"
app_query({ windowId: "si-word", stateKey: "stats" })    # should have words > 0
app_query({ windowId: "si-word", stateKey: "text" })     # should contain "self-inspection test"
close({ windowId: "si-word" })
```

**PASS** if title, stats, and text match expectations.

### 7. Cross-App Data Flow (Storage → Excel)

Write structured data to storage, then import it into Excel via App Protocol:

```
write({ path: "_si-test-data.json", content: "{\"cells\":{\"A1\":\"Product\",\"B1\":\"Price\",\"A2\":\"Widget\",\"B2\":\"9.99\",\"A3\":\"Gadget\",\"B3\":\"24.50\"},\"styles\":{\"A1\":{\"bold\":true},\"B1\":{\"bold\":true}}}" })
read({ path: "_si-test-data.json" })     # verify JSON is readable
```

Open Excel and import:
```
create({ windowId: "si-cross", title: "Cross-App Test", appId: "excel-lite", content: { renderer: "iframe" } })
```

Wait for ready, then import the data you read from storage:
```
app_command({ windowId: "si-cross", command: "importWorkbook", params: { data: <parsed JSON from storage read> } })
app_query({ windowId: "si-cross", stateKey: "cells" })
```
Verify A1="Product", B2="9.99".

Cleanup:
```
close({ windowId: "si-cross" })
delete({ path: "_si-test-data.json" })
```

**PASS** if imported data matches the original JSON.

### 8. Dev Pipeline (Write → Compile → Deploy → Verify → Cleanup)

Test the full app development pipeline:

**Step 1 — Write source:**
```
write_ts({ path: "src/main.ts", content: "document.body.innerHTML = '<h1 id=\"si-test\">Self Inspection Dev Test</h1><p>Compiled and deployed successfully.</p>'; document.body.style.cssText = 'font-family:system-ui;padding:24px;';" })
```
Record the returned `sandboxId`.

**Step 2 — Compile:**
```
compile({ sandbox: <sandboxId> })
```
**PASS (compile)** if `previewUrl` is returned.

**Step 3 — Deploy:**
```
deploy({ sandbox: <sandboxId>, appId: "si-dev-test", name: "SI Dev Test", icon: "🧪", description: "Temporary test app from self-inspection", hidden: true })
```
**PASS (deploy)** if deploy succeeds without error.

**Step 4 — Verify deployment:**
```
http_get({ url: "http://localhost:8000/api/apps" })
```
Verify "si-dev-test" appears in the app list.

**Step 5 — Open and verify:**
```
create({ windowId: "si-dev-verify", title: "Dev Test Verify", appId: "si-dev-test", content: { renderer: "iframe" } })
list()    # verify window exists
close({ windowId: "si-dev-verify" })
```

**Step 6 — Cleanup (delete the test app):**
```
market_delete({ appId: "si-dev-test" })
```
Verify it no longer appears in the app list.

**PASS** if all 6 steps complete successfully.

### 9. Sandbox Stress Tests

Run multiple sandbox executions testing edge cases:

**9a — Async/await:**
```
run_js({ code: "const r = await fetch('http://localhost:8000/health').then(r=>r.json()); JSON.stringify(r)" })
```
**PASS** if returns `{"status":"ok"}`.

**9b — Computation:**
```
run_js({ code: "let sum = 0; for (let i = 0; i < 1000000; i++) sum += i; JSON.stringify({ sum })" })
```
**PASS** if returns `{"sum":499999500000}`.

**9c — Error handling:**
```
run_js({ code: "throw new Error('intentional test error')" })
```
**PASS** if error is caught and reported (not a crash).

**9d — Crypto:**
```
run_js({ code: "const hash = crypto.createHash('sha256').update('self-inspection').digest('hex'); hash" })
```
**PASS** if returns a 64-character hex string.

**9e — Multiple return types:**
```
run_js({ code: "JSON.stringify({ string: 'hello', number: 42, bool: true, array: [1,2,3], nested: { a: 1 } })" })
```
**PASS** if all types are preserved in the output.

### 10. Shortcut Create/Delete

```
create_shortcut({ id: "si-test-shortcut", label: "SI Test", icon: "🧪", type: "action", target: "self-inspection test" })
list_shortcuts()     # verify "si-test-shortcut" appears
remove_shortcut({ id: "si-test-shortcut" })
list_shortcuts()     # verify it's gone
```

**PASS** if shortcut appears after create and disappears after remove.

### 11. Component Update

Create a component window, then replace its entire layout:

```
create_component({
  windowId: "si-comp-upd",
  title: "Component Update Test",
  width: 350, height: 200,
  components: [
    { type: "text", content: "Version 1", variant: "heading" },
    { type: "progress", value: 25, label: "Progress" }
  ]
})
```

Update the components:
```
update_component({
  windowId: "si-comp-upd",
  components: [
    { type: "text", content: "Version 2", variant: "heading" },
    { type: "progress", value: 100, label: "Complete", variant: "success" },
    { type: "badge", label: "Updated", variant: "info" }
  ]
})
```

```
close({ windowId: "si-comp-upd" })
```

**PASS** if update_component succeeds without error.

### 12. Storage Directory Operations

Test directory creation and listing:

```
write({ path: "_si-test-dir/file1.txt", content: "File 1" })
write({ path: "_si-test-dir/file2.txt", content: "File 2" })
write({ path: "_si-test-dir/sub/file3.txt", content: "File 3" })
list({ path: "_si-test-dir" })           # should show file1.txt, file2.txt, sub/
list({ path: "_si-test-dir/sub" })       # should show file3.txt
delete({ path: "_si-test-dir/file1.txt" })
delete({ path: "_si-test-dir/file2.txt" })
delete({ path: "_si-test-dir/sub/file3.txt" })
```

**PASS** if directory listing shows expected files and subdirectory.

### 13. Multi-App Simultaneous

Open 3 App Protocol apps simultaneously and interact with all of them:

```
create({ windowId: "si-multi-excel", title: "Multi: Excel", appId: "excel-lite", content: { renderer: "iframe" } })
create({ windowId: "si-multi-word", title: "Multi: Word", appId: "word-lite", content: { renderer: "iframe" } })
create({ windowId: "si-multi-img", title: "Multi: Images", appId: "image-viewer", content: { renderer: "iframe" } })
```

Wait for all 3 to be ready, then interact with each:

```
app_command({ windowId: "si-multi-excel", command: "setCells", params: { cells: { "A1": "Multi-app test" } } })
app_command({ windowId: "si-multi-word", command: "setHtml", params: { html: "<p>Multi-app test</p>" } })
app_command({ windowId: "si-multi-img", command: "setLayout", params: { mode: "grid", columns: 3 } })
```

Query each to verify:
```
app_query({ windowId: "si-multi-excel", stateKey: "cells" })    # A1 = "Multi-app test"
app_query({ windowId: "si-multi-word", stateKey: "text" })      # contains "Multi-app test"
app_query({ windowId: "si-multi-img", stateKey: "layout" })     # mode = "grid"
```

Close all:
```
close({ windowId: "si-multi-excel" })
close({ windowId: "si-multi-word" })
close({ windowId: "si-multi-img" })
```

**PASS** if all 3 apps respond correctly to commands and queries simultaneously.

---

## Report Format

After all checks, create a markdown window with the results:

```
create({
  windowId: "self-inspection-report",
  title: "Self Inspection Report",
  width: 700, height: 700,
  content: {
    renderer: "markdown",
    content: "# Self Inspection Report\n\n| # | Check | Status | Details |\n|---|-------|--------|---------|\n| 1 | Multi-Renderer Windows | PASS | 5/5 renderers created |\n| 2 | Content Updates | PASS | append/prepend/replace verified |\n| 3 | Window Lock/Unlock | PASS | lock rejected update, unlock allowed |\n| 4 | Form Submission | PASS | received username, color fields |\n| 5 | App Protocol (Excel) | PASS | setCells/query/clearRange verified |\n| 6 | App Protocol (Word) | PASS | setHtml/title/stats verified |\n| 7 | Cross-App Data Flow | PASS | storage → excel import verified |\n| 8 | Dev Pipeline | PASS | write → compile → deploy → cleanup |\n| 9 | Sandbox Stress | PASS | 5/5 subtests passed |\n| 10 | Shortcuts | PASS | create/list/remove verified |\n| 11 | Component Update | PASS | layout replaced successfully |\n| 12 | Storage Directories | PASS | nested dirs and listing verified |\n| 13 | Multi-App Simultaneous | PASS | 3 apps commanded simultaneously |\n\n**Result: X/13 checks passed**"
  }
})
```

Mark each check as:
- **PASS** — expected result received
- **FAIL** — unexpected result or error (include error message in Details)
- **SKIP** — could not run (explain why in Details)

## Cleanup Guarantee

If any test fails partway through, always attempt cleanup (close windows, delete test files, remove test apps). Never leave test artifacts behind. Window IDs used by self-inspection all start with `si-` for easy identification.
