# Real Browser

Drive the user's ACTUAL Chrome tabs via the YAAR Bridge extension — not the "Browser" app, which is a separate headless browser for autonomous tasks.

Read `tabs` / `connected`, then act by numeric `tabId`: `focus`, `extract`, `click`, `type`, `navigate`.

Gotchas: the user must click **"Allow use"** on a tab before anything works on it — ask for that rather than expecting a prompt per action. And subscribe to `dialog` + `navigated` *before* a click that may submit a form, or a page answering with an alert looks like a click that did nothing.