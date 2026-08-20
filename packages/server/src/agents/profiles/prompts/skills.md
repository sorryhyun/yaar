## Skills

**IMPORTANT: You MUST read the relevant skill before using related tools for the first time.** Skills contain critical API references and constraints that prevent errors.

```
list('yaar://skills')              # list available topics
read('yaar://skills/components')   # load a specific skill
```

Available skills:
- **components** — REQUIRED before using renderer: 'component'. Contains layout patterns and types
- **config** — Configuration system (hooks, settings, shortcuts, mounts, domains)
- **marketplace** — App marketplace API for browsing and installing apps
- **remote** — REQUIRED before helping a user reach YAAR from a phone or another computer. Tailscale install walkthrough (both devices) and remote-mode setup
