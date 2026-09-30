# Phone Files on Android (Termux)

Android/Termux only. Read this when YAAR runs on the user's phone and they want a file that
lives on the phone — "open the PDF in my downloads", "edit the photo I just took" — or say YAAR
cannot see their files.

Out of the box, Termux (and so YAAR) sees only its own home directory, not the phone's
Download, DCIM, Pictures or Documents folders. Two steps fix that: the **user** grants storage
access once, then **you** mount the folders they need into YAAR storage.

**Shared storage right now: {{SHARED_STORAGE_STATUS}}.** This is checked each time you read
this topic, so read it again after the user says they finished step 2.

## 1. Check what is already there

```
read('yaar://config/mounts')
```

If a mount already points at the folder you need, use `yaar://storage/mounts/{alias}/` and stop.

## 2. The user grants storage access (skip if granted above)

You cannot run shell commands. Give the user these steps and ask them to tell you when they are
done:

1. Switch to the **Termux** app.
2. Run `termux-setup-storage`.
3. Allow the permission Android asks for. Depending on the Android version this is a dialog or
   a settings screen ("Allow access to manage all files") — turn it on there.
4. Come back to YAAR.

Then read this topic again to confirm the status changed to granted.

## 3. Mount only the folders needed

Mount each folder on its own. Do not mount all of `/storage/emulated/0` at once — it exposes
everything on the phone, and listing it is slow (shared storage goes through Android's FUSE
layer).

```
invoke('yaar://config/mounts', { alias: 'phone-downloads', hostPath: '/storage/emulated/0/Download', readOnly: false })
invoke('yaar://config/mounts', { alias: 'phone-camera', hostPath: '/storage/emulated/0/DCIM', readOnly: true })
```

| Folder | Path | Suggested |
|--------|------|-----------|
| Downloads | `/storage/emulated/0/Download` | writable |
| Camera photos | `/storage/emulated/0/DCIM` | `readOnly: true` — save edits elsewhere |
| Pictures (screenshots) | `/storage/emulated/0/Pictures` | `readOnly: true` |
| Documents | `/storage/emulated/0/Documents` | writable |

Use the real `/storage/emulated/0/...` paths, not the `~/storage/...` links
`termux-setup-storage` creates — the real path says what the mount is.

The user approves each mount in a dialog. After that the folder is at
`yaar://storage/mounts/{alias}/`.

## When it fails

- **"Host path is not readable"** — storage access was not granted, or was revoked. Go back to
  step 2.
- **"Host path does not exist"** — the folder name is wrong for this phone. Ask the user which
  folder the file is in; some phones use `Downloads` or keep photos under `DCIM/Camera`.

## Sending a file back out

To hand a file from YAAR storage to another phone app, use the share sheet:
`invoke('yaar://storage/{path}', { action: 'share' })`.
