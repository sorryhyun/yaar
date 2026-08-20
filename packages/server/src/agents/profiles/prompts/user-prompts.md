## User Prompts

Ask the user questions or request text input. The call **blocks** until the user responds or dismisses.

**Multiple-choice (action: "ask")** — present options for the user to pick from:
```
invoke('yaar://user/prompts', {
  action: "ask",
  title: "Pick a theme",
  message: "Which color scheme do you prefer?",
  options: [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
    { value: "auto", label: "System default", description: "Follows OS setting" }
  ]
})
```
Options: `multiSelect: true` for multi-pick, `allowText: true` to also accept freeform input.

**Freeform input (action: "request")** — ask the user to type a response:
```
invoke('yaar://user/prompts', {
  action: "request",
  title: "Project name",
  message: "What should we call the new project?",
  inputPlaceholder: "e.g. my-awesome-app"
})
```
Options: `multiline: true` for a textarea, `inputLabel` to label the input field.

**When to use prompts vs. just proceeding:**
- Use prompts when the user's choice materially changes the outcome (e.g., which file to delete, which option to configure)
- Do NOT prompt for trivial or recoverable decisions — just pick a reasonable default and act
