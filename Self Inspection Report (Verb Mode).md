# Self Inspection Report (Verb Mode)

| # | Check | Status | Details |
|---|-------|--------|---------|
| 1 | Describe & Discovery | PASS | 7/7 describe calls returned valid verbs and descriptions. |
| 2 | Session Root & Namespaces | FAIL | Root read worked, but `list(yaar://)` returned 7 namespaces rather than the expected 9. |
| 3 | Multi-Renderer Windows | PASS | 5/5 test windows created and verified via `list(yaar://windows/)`. |
| 4 | Content Updates | PASS | append, prepend, and replace all matched expected reads. |
| 5 | Window Lock/Unlock | FAIL | Locked window still accepted `update`; rejection did not occur. |
| 6 | Form Submission | FAIL | Form submitted, but required `color` field came through blank (`Username: d`, `Favorite Color: (blank)`). |
| 7 | App Protocol (Excel) | PASS | Manifest, `setCells`, `app_query(cells)`, and `clearRange` all verified. |
| 8 | App Protocol (Word) | PASS | `setTitle`, `setContent`, `stats`, and `text` queries all verified. |
| 9 | Cross-App Data Flow | PASS | Storage JSON imported into Excel; queried cells matched expected values. |
| 10 | Dev Pipeline | SKIP | Could not run: required legacy compile/deploy tools were unavailable in this session. |
| 11 | Sandbox Stress | SKIP | Could not run: required legacy `run_js` tool was unavailable in this session. |
| 12 | Shortcuts via Config URI | PASS | Shortcut created, verified in config, then removed successfully. |
| 13 | Component Update | PASS | `update_component` succeeded and replaced the layout. |
| 14 | Storage Directories | PASS | Nested files and listings worked as expected. Empty directories remained because directory delete is unsupported (`EISDIR`). |
| 15 | Multi-App Simultaneous | PASS | Excel, Word, and Image Viewer all accepted commands and returned state successfully. |
| 16 | Monitor-as-Resource | PASS | `read(yaar://sessions/current/monitors)` returned monitor status and window counts. |
| 17 | Agents Discovery | FAIL | `list(yaar://sessions/current/agents)` returned summary counts only; no agent IDs were exposed for per-agent read. |
| 18 | User Notifications | PASS | Notification invoke succeeded. |

**Result: 12/18 checks passed**

### Cleanup
- Closed all `si-v-*` windows.
- Removed test files and shortcut.
- Empty directories `_si-v-test-dir/` and `_si-v-test-dir/sub/` remain because directory deletion via verb layer returned `EISDIR`.

### Notes
- The initial **Self Inspection** app window could not embed because this app is skill-only, not iframe-based.
- Mixed-mode tests (#10, #11) were skipped due missing non-verb tools in this environment.

## Friction Notes (worked, but inconvenient)
- Opening **Self Inspection** from the app icon is misleading because it is skill-only; the iframe window opens but cannot embed content.
- `read(yaar://sessions/current/monitors)` shows monitor summary only, so I had to use `list(yaar://windows/)` to verify specific test windows.
- Form verification is awkward: submitted values were reflected as rendered component text, not returned as structured form payload to the main agent.
- Root namespace expectations are unclear: the app spec expected 9 namespaces, but the environment exposed 7.
- Agent discovery is not very ergonomic: `list(yaar://sessions/current/agents)` returned counts, not concrete agent IDs to inspect.
- Storage cleanup is incomplete ergonomically: files delete fine, but empty test directories remain because directory delete returns `EISDIR`.
- App state can persist between tests, so multi-app verification can inherit prior data unless the app is explicitly reset first.
- Lock behavior lacks a strong signal: `lock` succeeded, but a later `update` still worked, so the contract is unclear.
- Mixed-mode coverage is hard to complete from verb mode because skipped tests depend on legacy tools that may or may not exist in the current session.