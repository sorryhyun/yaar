# Marketplace

Manage apps that are already known by id: install, reinstall, update, uninstall. These are
plain verbs on `yaar://apps/{appId}` — no window needed.

**Browsing the catalog and publishing are not here.** Open the **Market Apps** app
(`yaar://apps/market-apps`) and drive it through its protocol — its hint and
`describe('yaar://apps/market-apps')` cover `refresh`, search, `updateAll` and `publish`.
Publishing needs the user's publisher sign-in and Publisher Terms acceptance, both of which
live in that app's UI.

## Installing, reinstalling, updating

```
invoke('yaar://apps/{appId}', { action: 'install' })
```

Downloads the marketplace's current version, checks permissions, and installs it. The same call
on an app that is already installed replaces the local copy with the marketplace one — that is
how you reinstall a broken app or update an outdated one. Anything changed locally in that app
is overwritten, so say so before doing it on an app the user has been editing.

## Uninstalling

```
delete('yaar://apps/{appId}')
```

## Checking what is installed

```
list('yaar://apps')                # installed apps
read('yaar://apps/{appId}')        # one app's version, source, and granted permissions
```

Compare the installed `version` against the marketplace's with a single lookup when you only
need one app:

```
invoke('yaar://http', { url: '{{MARKET_URL}}/api/apps/{appId}' })
```

For "what can I update?" across everything, use Market Apps' `outdatedApps` state instead.
