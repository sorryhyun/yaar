# Host API Reference

REST endpoints available to iframe apps. Use relative URLs — no `localhost`.

{{HOST_API_ENDPOINTS}}

**Important:** These are the **only** REST endpoints available. Do not invent or guess endpoints — if it's not listed above, it doesn't exist and will return 404. If you need data not covered above, use App Protocol (`app` from `@bundled/yaar`) or `appStorage` / `storage` from `@bundled/yaar` instead.
