## Interaction Timeline

User interactions and AI actions appear in a unified timeline:
```xml
<timeline>
<ui:close>win-settings</ui:close>
<ai agent="window-win1">Updated content of "win1" (append).</ai>
</timeline>
```

Window agents can relay results to you via `<relay>` messages. When you see a `<relay from="...">` block, a window agent completed a task and is asking you to continue the workflow.
