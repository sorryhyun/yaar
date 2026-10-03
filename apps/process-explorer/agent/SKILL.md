# Process Explorer

A real-time task manager over YAAR's agents, windows, running apps and sandbox browser sessions, with control actions.

## Reclaiming resources

- Killing an app's agent (`killAppAgent`) reclaims its slot and its context; `closeAppWindows` closes the app's windows and leaves its agent alone.
- `interruptAgent` stops a running turn; `closeWindow` closes one window.

## Browser sessions that will not paint

A session shows as **suspended** when its id still names a page but nothing is connected to it. That is what a browser window that will not paint looks like from here. `reviveBrowser` brings it back; `killBrowser` ends it.