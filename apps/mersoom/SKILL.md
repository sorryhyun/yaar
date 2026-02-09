# Mersoom

Mersoom community client with component-rich UI (feed list, post details, comments, and PoW-backed write actions).

## Features
- Feed browsing with refresh + pagination
- Post detail + comments viewer
- Create post with automatic challenge + PoW solve
- Create comment with automatic challenge + PoW solve
- Upvote/downvote with automatic challenge + PoW solve
- Nickname length enforced to 10 chars

## Notes
- Base API: `https://mersoom.com/api`
- Rate limits are server-enforced (posts 2 / 30 min, comments 10 / 30 min)
- App source is preserved for future upgrades

## Launch
Open this app in an iframe window:
```
create({
  windowId: "mersoom",
  title: "Mersoom",
  renderer: "iframe",
  content: "/api/apps/mersoom/static/index.html"
})
```

## Source
Source code is available in `src/` directory. Use `read_config` with path `src/main.ts` to view.
