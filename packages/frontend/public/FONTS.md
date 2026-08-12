# Fonts served by YAAR

These files are published at the site root and served unauthenticated
(`isStaticAsset` in `packages/server/src/http/auth.ts`) — a CSS-initiated font
fetch cannot attach a token, so they have to be.

They are also read by the server itself. `packages/server/src/features/fonts/`
parses and subsets them for `yaar://system/fonts`, which is how an app gets a
face small enough to inline as a `data:` URL — the only kind of font an SVG
rasteriser will load. **`catalog.ts` is the list that matters**; a file added
here is not served until it has a row there, and a row whose file is missing is
dropped from the catalog rather than advertised.

| Family | Files | Outlines | Notes |
|---|---|---|---|
| NanumSquareNeo | `NanumSquareNeoOTF-{Lt,Rg,Bd,Eb}.otf` | CFF (`OTTO`) | The UI and document face. Four weights: 300/400/700/800. |
| D2Coding | `D2Coding.ttf` | TrueType (`glyf`) | The monospace face, for code. Ver 1.3.3, non-ligature build. Regular only — see `catalog.ts` for why, and how to add Bold. |

## Licenses

- **D2Coding** — SIL Open Font License 1.1. The license text ships beside it as
  `D2Coding-OFL.txt`, which is what the OFL requires. Upstream:
  <https://github.com/naver/d2codingfont>.
- **NanumSquareNeo** — Naver's font, redistributed under its own free-use terms.
  Upstream: <https://campaign.naver.com/nanumsquare_neo/>.

## Why raw `.otf`/`.ttf` and not `.woff2`

The server parses these files, and a `.woff2` would need a Brotli decompressor
before a single byte could be read. Uncompressed containers cost bandwidth on
the *full*-face fetch only; the subsets an app actually embeds are built from
them and are a fraction of the size (~96 KB for a page of NanumSquareNeo).
