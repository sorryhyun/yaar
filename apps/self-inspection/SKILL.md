# Self Inspection

A deep diagnostic suite that stress-tests YAAR's verb layer, using **only the 5 generic verbs** (`describe`, `read`, `list`, `invoke`, `delete`) against `yaar://` URIs.

## Launch

This is a pure-skill app — no iframe or compiled code. Follow the instructions below using verb tools directly.

When the user opens this app or says "run verb inspection", "run verb diagnostics", or "verb self-test", run all checks below and produce the report.

---

## Diagnostics

### 1. Describe & Discovery

Test that `describe` returns valid schemas for key resources across multiple domains:

```
describe('yaar://config/settings')
describe('yaar://storage')
describe('yaar://session/monitors')
describe('yaar://user/notifications')
describe('yaar://apps')
describe('yaar://session/agents')
describe('yaar://session')
```

**PASS** if all 7 describe calls return verbs arrays and descriptions without errors.

### 2. Session Root & Namespace Listing

Test the root resource and namespace enumeration:

```
read('yaar://')                    # should return session overview (sessionId, platform, etc.)
list('yaar://')                    # should return all 7 URI namespaces (apps, storage, windows, config, session, user, history)
list('yaar://config/')             # should return config sections (settings, hooks, shortcuts, mounts, app)
```

**PASS** if root read returns session info and both list calls return expected items.

### 3. Concurrent Multi-Renderer Windows

Open 5 windows simultaneously using different renderers via `invoke`, verify all exist via `list`, then close all via `delete`:

```
invoke('yaar://windows/si-v-md', { action: "create", title: "Test: Markdown", width: 300, height: 200, renderer: "markdown", content: "# Markdown\n\n**Bold** and *italic*." })
invoke('yaar://windows/si-v-html', { action: "create", title: "Test: HTML", width: 300, height: 200, renderer: "html", content: "<div style='padding:16px'><h2>HTML</h2><p style='color:green'>Styled content.</p></div>" })
invoke('yaar://windows/si-v-text', { action: "create", title: "Test: Text", width: 300, height: 200, renderer: "text", content: "Plain text content.\nLine 2.\nLine 3." })
invoke('yaar://windows/si-v-comp', { action: "create", title: "Test: Component", width: 300, height: 200, renderer: "component", content: { components: [{ "type": "text", "content": "Component DSL", "variant": "heading" }, { "type": "badge", "label": "OK", "variant": "success" }, { "type": "progress", "value": 75, "label": "Progress" }] } })
invoke('yaar://windows/si-v-tbl', { action: "create", title: "Test: Table", width: 300, height: 200, renderer: "table", content: { "headers": ["Col A", "Col B"], "rows": [["1", "2"], ["3", "4"]] } })
```

Verify:
```
list('yaar://session/monitors')   # all 5 windows should appear: si-v-md, si-v-html, si-v-text, si-v-comp, si-v-tbl
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

Lock semantics: a locked window can only be modified by the agent that locked it. Other agents are rejected.

```
invoke('yaar://windows/si-v-lock', { action: "create", title: "Lock Test", renderer: "text", content: "Locked window test." })
invoke('yaar://windows/si-v-lock', { action: "lock" })
read('yaar://windows/si-v-lock')            # verify locked: true and lockedBy matches current agent
```
The locking agent can still update its own locked window:
```
invoke('yaar://windows/si-v-lock', { action: "update", operation: "replace", content: "Updated by locking agent." })
read('yaar://windows/si-v-lock')            # should contain "Updated by locking agent."
```
Unlock and verify state change:
```
invoke('yaar://windows/si-v-lock', { action: "unlock" })
read('yaar://windows/si-v-lock')            # verify locked: false
delete('yaar://windows/si-v-lock')
```

**PASS** if lock metadata is correct, locking agent can update, and unlock clears the lock.

### 6. Component Form Submission (interactive)

Create a component window with a form and ask the user to fill it:

```
invoke('yaar://windows/si-v-form', {
  action: "create",
  title: "Form Test",
  renderer: "component",
  width: 400, height: 300,
  content: {
    components: [
      { "type": "text", "content": "Fill out this form and click Submit.", "variant": "heading" },
      { "type": "input", "name": "username", "formId": "test-form", "label": "Username", "placeholder": "Enter anything" },
      { "type": "select", "name": "color", "formId": "test-form", "label": "Favorite Color", "options": [{ "value": "red", "label": "Red" }, { "value": "blue", "label": "Blue" }, { "value": "green", "label": "Green" }] },
      { "type": "input", "name": "notes", "formId": "test-form", "label": "Notes", "placeholder": "Optional", "rows": 2 },
      { "type": "button", "label": "Submit", "submitForm": "test-form", "action": "form-submitted", "variant": "primary" }
    ]
  }
})
```

Tell the user: "Please fill out the form and click **Submit**."
When you receive the `COMPONENT_ACTION` event with form data, read the submitted values and close the window.
**PASS** if form data is received with `username` and `color` fields.
```
delete('yaar://windows/si-v-form')
```

### 7. App Protocol Round-Trip (Memo)

Open Memo, query its manifest, write a record, read it back, verify data integrity:

```
invoke('yaar://windows/si-v-memo', { action: "create", title: "Memo", appId: "memo", renderer: "iframe", content: "yaar://apps/memo" })
```

Wait for App Protocol ready, then query manifest:
```
invoke('yaar://windows/si-v-memo', { action: "app_query" })
```
Verify manifest contains `addMemo` command and `memos` state key.

Write test data (note the returned memo id):
```
invoke('yaar://windows/si-v-memo', { action: "app_command", command: "addMemo", params: { "title": "SI Test", "content": "self-inspection round-trip" } })
```

Read back:
```
invoke('yaar://windows/si-v-memo', { action: "app_query", stateKey: "memos" })
```
Verify a memo with title="SI Test" and content="self-inspection round-trip" is present.

Test updateMemo and deleteMemo:
```
invoke('yaar://windows/si-v-memo', { action: "app_command", command: "updateMemo", params: { "id": "<the-memo-id>", "content": "edited" } })
invoke('yaar://windows/si-v-memo', { action: "app_query", stateKey: "memos" })
invoke('yaar://windows/si-v-memo', { action: "app_command", command: "deleteMemo", params: { "id": "<the-memo-id>" } })
invoke('yaar://windows/si-v-memo', { action: "app_query", stateKey: "memos" })
```
Verify the content updated to "edited", then that the memo is gone after delete.

```
delete('yaar://windows/si-v-memo')
```

**PASS** if all read-back values match expectations.

### 8. App Protocol Round-Trip (Video Editor Lite)

Open Video Editor Lite, build a composition, read it back:

```
invoke('yaar://windows/si-v-video', { action: "create", title: "Video Editor Lite", appId: "video-editor-lite", renderer: "iframe", content: "yaar://apps/video-editor-lite" })
```

Wait for ready, then:
```
invoke('yaar://windows/si-v-video', { action: "app_command", command: "createComposition", params: { "width": 1280, "height": 720, "fps": 30, "durationInFrames": 150 } })
invoke('yaar://windows/si-v-video', { action: "app_command", command: "addScene", params: { "type": "text", "durationInFrames": 90, "props": { "text": "Self Inspection Test" } } })
invoke('yaar://windows/si-v-video', { action: "app_query", stateKey: "composition" })  # should show 1 scene of type "text"
invoke('yaar://windows/si-v-video', { action: "app_query", stateKey: "layers" })       # should show 1 layer containing the new scene
delete('yaar://windows/si-v-video')
```

**PASS** if the composition and layers reflect the created scene.

### 9. Cross-App Data Flow (Storage → Video Editor Lite)

Write a scene definition to storage via invoke, then import it into Video Editor Lite via App Protocol:

```
invoke('yaar://storage/_si-v-test-data.json', { action: "write", content: "{\"type\":\"text\",\"durationInFrames\":60,\"props\":{\"text\":\"Imported Scene\"}}" })
read('yaar://storage/_si-v-test-data.json')     # verify JSON is readable
```

Open Video Editor Lite and import:
```
invoke('yaar://windows/si-v-cross', { action: "create", title: "Cross-App Test", appId: "video-editor-lite", renderer: "iframe", content: "yaar://apps/video-editor-lite" })
```

Wait for ready, then import the data you read from storage:
```
invoke('yaar://windows/si-v-cross', { action: "app_command", command: "createComposition", params: {} })
invoke('yaar://windows/si-v-cross', { action: "app_command", command: "addScene", params: <parsed JSON from storage read> })
invoke('yaar://windows/si-v-cross', { action: "app_query", stateKey: "composition" })
```
Verify the composition contains one scene of type "text" with the imported text "Imported Scene".

Cleanup:
```
delete('yaar://windows/si-v-cross')
delete('yaar://storage/_si-v-test-data.json')
```

**PASS** if the imported scene data matches the original JSON.

### 10. Shortcut Create/Delete via Config URI

```
invoke('yaar://config/shortcuts', { label: "SI Verb Test", icon: "🧪", shortcutType: "action", target: "self-inspection test" })
read('yaar://config/shortcuts')     # verify shortcut appears, note the shortcutId
delete('yaar://config/shortcuts/<the-shortcut-id>')
read('yaar://config/shortcuts')     # verify it's gone
```

**PASS** if shortcut appears after create and disappears after remove.

### 11. Component Update

Create a component window, then replace its entire layout:

```
invoke('yaar://windows/si-v-comp-upd', {
  action: "create",
  title: "Component Update Test",
  renderer: "component",
  width: 350, height: 200,
  content: {
    components: [
      { "type": "text", "content": "Version 1", "variant": "heading" },
      { "type": "progress", "value": 25, "label": "Progress" }
    ]
  }
})
```

Update the components:
```
invoke('yaar://windows/si-v-comp-upd', {
  action: "update",
  operation: "replace",
  renderer: "component",
  content: {
    components: [
      { "type": "text", "content": "Version 2", "variant": "heading" },
      { "type": "progress", "value": 100, "label": "Complete", "variant": "success" },
      { "type": "badge", "label": "Updated", "variant": "info" }
    ]
  }
})
```

```
delete('yaar://windows/si-v-comp-upd')
```

**PASS** if component update succeeds without error.

### 12. Storage Directory Operations via URI

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

### 13. Multi-App Simultaneous

Open 3 App Protocol apps simultaneously and interact with all of them:

```
invoke('yaar://windows/si-v-multi-memo', { action: "create", title: "Multi: Memo", appId: "memo", renderer: "iframe", content: "yaar://apps/memo" })
invoke('yaar://windows/si-v-multi-video', { action: "create", title: "Multi: Video", appId: "video-editor-lite", renderer: "iframe", content: "yaar://apps/video-editor-lite" })
invoke('yaar://windows/si-v-multi-proc', { action: "create", title: "Multi: Process Explorer", appId: "process-explorer", renderer: "iframe", content: "yaar://apps/process-explorer" })
```

Wait for all 3 to be ready, then interact with each:

```
invoke('yaar://windows/si-v-multi-memo', { action: "app_command", command: "addMemo", params: { "title": "Multi", "content": "Multi-app test" } })
invoke('yaar://windows/si-v-multi-video', { action: "app_command", command: "createComposition", params: {} })
invoke('yaar://windows/si-v-multi-proc', { action: "app_command", command: "refresh", params: {} })
```

Query each to verify:
```
invoke('yaar://windows/si-v-multi-memo', { action: "app_query", stateKey: "memos" })        # contains "Multi-app test"
invoke('yaar://windows/si-v-multi-video', { action: "app_query", stateKey: "composition" }) # composition config present
invoke('yaar://windows/si-v-multi-proc', { action: "app_query", stateKey: "stats" })        # stats returned
```

Close all:
```
delete('yaar://windows/si-v-multi-memo')
delete('yaar://windows/si-v-multi-video')
delete('yaar://windows/si-v-multi-proc')
```

**PASS** if all 3 apps respond correctly to commands and queries simultaneously.

### 14. Monitor-as-Resource

Read the monitor resource to verify it returns status:

```
read('yaar://session/monitors')
```

**PASS** if returns monitorId, hasMainAgent, windows list, and stats.

### 15. Agents Discovery

List and inspect active agents:

```
list('yaar://session/agents')
```

If agents are listed, read one:
```
read('yaar://session/agents/<first-agent-id>')
```

**PASS** if agent list returns without error and (if agents exist) individual agent read returns agent info.

### 16. User Notifications via URI

Test notification lifecycle through verb layer:

```
invoke('yaar://user/notifications', { title: "Verb Test", body: "Self-inspection notification test", variant: "info" })
```

**PASS** if notification is shown without error.

---

## Report Format

After all checks, create a markdown window with the results:

```
invoke('yaar://windows/self-inspection-report', {
  action: "create",
  title: "Self Inspection Report",
  width: 750, height: 750,
  renderer: "markdown",
  content: "# Self Inspection Report\n\n| # | Check | Status | Details |\n|---|-------|--------|---------|\n| 1 | Describe & Discovery | PASS | 7/7 resources described |\n| 2 | Session Root & Namespaces | PASS | root read + 2 list calls verified |\n| 3 | Multi-Renderer Windows | PASS | 5/5 renderers created |\n| 4 | Content Updates | PASS | append/prepend/replace verified |\n| 5 | Window Lock/Unlock | PASS | lock metadata correct, owner update allowed, unlock cleared |\n| 6 | Form Submission | PASS | received username, color fields |\n| 7 | App Protocol (Memo) | PASS | addMemo/updateMemo/deleteMemo verified |\n| 8 | App Protocol (Video Editor Lite) | PASS | createComposition/addScene/getComposition verified |\n| 9 | Cross-App Data Flow | PASS | storage → video-editor-lite scene import verified |\n| 10 | Shortcuts via Config URI | PASS | create/list/remove verified |\n| 11 | Component Update | PASS | layout replaced successfully |\n| 12 | Storage Directories | PASS | nested dirs and listing verified |\n| 13 | Multi-App Simultaneous | PASS | 3 apps commanded simultaneously |\n| 14 | Monitor-as-Resource | PASS | monitor status returned |\n| 15 | Agents Discovery | PASS | agent list/read verified |\n| 16 | User Notifications | PASS | notification shown |\n\n**Result: X/16 checks passed**\n\n### Verb Coverage\n| Verb | Tested In |\n|------|-----------|\n| describe | #1 |\n| read | #2, #4, #5, #14, #15 |\n| list | #2, #3, #12, #15 |\n| invoke | #3–#13, #16 |\n| delete | #3–#5, #9, #10, #12, #13 |"
})
```

Mark each check as:
- **PASS** — expected result received
- **FAIL** — unexpected result or error (include error message in Details)
- **SKIP** — could not run (explain why in Details)

## Cleanup Guarantee

If any test fails partway through, always attempt cleanup (close windows, delete test files, remove test apps). Never leave test artifacts behind. Window IDs used by this inspection all start with `si-v-` for easy identification.

## Verb Coverage Notes

All diagnostics use the 5 generic verbs exclusively (`describe`, `read`, `list`, `invoke`, `delete`) against `yaar://` URIs.
