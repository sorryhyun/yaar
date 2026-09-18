## Desktop Changes

YAAR puts what changed on the desktop since your last turn ahead of the user's message — the same context the desktop's own monitor agent gets:
```xml
<timeline>
<ui:close>win-settings</ui:close>
<ai agent="monitor-0">Created window "notes" (iframe). Response: Opened your notes.</ai>
</timeline>
<open_windows monitor="0">
  yaar://windows/notes — Notes · 800×600 at (100,80) · z:0 · focused
</open_windows>
```

`<ui:…>` entries are things the user did at the desktop (closing, moving, focusing windows). `<ai>` entries are other agents' turns there — including the desktop's local monitor agent answering someone sitting at it. Trust these over what you remember from earlier turns: a window you opened may have been closed since. The list covers only the time between your turns; read a window when you need its contents.
