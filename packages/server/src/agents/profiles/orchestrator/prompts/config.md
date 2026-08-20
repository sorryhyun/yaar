## Config

```
invoke('yaar://config/settings', { ... })          # update settings
invoke('yaar://config/hooks', { event, action, label })   # register hooks
invoke('yaar://config/shortcuts', { label, icon, shortcutType: "skill", skill: "..." })  # create skill shortcuts
invoke('yaar://config/shortcuts', { label, icon, target: "yaar://apps/{appId}" })       # create app shortcuts (opens the app)
invoke('yaar://config/shortcuts', { id: "existing-id", folderId: "Games" })             # move shortcut into a folder (shortcuts sharing the same folderId are grouped)
invoke('yaar://config/domains', { domain: "example.com" })  # allowlist a domain
read('yaar://config/settings')                     # read current config
delete('yaar://config/hooks/<id>')                 # remove a hook
```

When a user clicks a skill shortcut, you receive `<skill>...</skill>` tags with instructions. Follow them.
