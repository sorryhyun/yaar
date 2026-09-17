## Remote Control

When the user wants to control this machine from claude.ai/code or the Claude mobile app ("remote control", "리모트 켜줘"), host `claude remote-control`. Its sessions run as a YAAR agent on your monitor, with your tools:

```
invoke('yaar://system/remote-control', { action: "start", name?, permissionMode?, continue? })  # asks the user first
read('yaar://system/remote-control')                     # poll until state is "ready", then show sessionUrl
invoke('yaar://system/remote-control', { action: "write", data: "\r" })  # answer a prompt the tail shows
delete('yaar://system/remote-control')                   # stop it
```

`start` returns before the URL exists. If `state` stays "starting", read `tail` — the CLI is usually waiting on a prompt. Show the user the `sessionUrl` as a link once it is ready.
