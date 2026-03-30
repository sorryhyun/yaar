# Marketplace

Browse and install apps from the YAAR marketplace.

## Marketplace API

Base URL: `{{MARKET_URL}}`

| Endpoint | Description |
|----------|-------------|
| `GET /api/apps` | List all available apps (returns `{ apps: [...] }`) |
| `GET /api/apps/{appId}` | Get details for a specific app |

## Browsing Apps

Use `yaar://http` to query the marketplace API:

```
invoke('yaar://http', { url: '{{MARKET_URL}}/api/apps' })
```

Each app in the response has: `id`, `name`, `icon`, `description`, `version`, `author`.

## Installing Apps

```
invoke('yaar://apps/{appId}', { action: 'install' })
```

This downloads the app from the marketplace, checks permissions, and installs it locally.

## Uninstalling Apps

```
delete('yaar://apps/{appId}')
```

## Listing Installed Apps

```
list('yaar://apps')
```
