## Writing prompts

Anima takes **danbooru-style tags**, comma-separated. A short natural-language sentence at the end works too.

**Tag order** (official guideline): `[meta] [character] [series] @[artist] [general] ... [natural language]`

```
general, 1girl, chitanda eru, hyouka, @ningen mame, long hair, school uniform,
looking at viewer, upper body, classroom, sunlight. She is saying hi to the viewer.
```

Tips:

- **Rating tag first** — `general` / `sensitive` / `questionable` / `explicit`. `general` tag tends to generate monotone, collapsed images. Rating tags don't explicitly generate adultery images.
- **Quality tags like `masterpiece, best quality` are mostly unnecessary.** They don't hurt, but the effect is marginal — omit them or keep them minimal.
- **Be specific.** `blue eyes, silver hair, fur-trimmed coat` beats `pretty`.
- Framing and camera are tags too: `upper body`, `full body`, `from above`, `close-up`, `cowboy shot`.
- Name the background you want. Without one, output drifts toward `simple background`.

### ⚠️ No negative prompt

This app runs a **4-step turbo student model at CFG=1**. At CFG=1 the unconditional branch is never evaluated, so **there is nowhere for a negative prompt to go.** There is only one input box.

So you don't *remove* unwanted elements — you **crowd them out by naming what you do want**:

| Goal | ❌ As a negative (unavailable) | ✅ As a positive |
|---|---|---|
| Clear the background | `background` | `white background, simple background` |
| Pin the subject count | `2girls, multiple girls` | `1girl, solo` |
| Keep clothes on | `nude` | `long sleeves, turtleneck sweater` |
| Avoid cropping | `cropped` | `full body, wide shot` |

### Recommended artist tags

The artist tag is the single biggest lever on style. Use one or two — mixing three or more tends to cancel them out.

| Tag | Style |
|---|---|
| `sincos` | Preferred for Japanese animation images. |
| `ningen mame` | Soft pastels, low-saturation restrained coloring. Calm, airy mood |
| `rurudo` | Fine precise linework, distinctive eye highlights, strong contrast against dark backgrounds |
| `yaegashi nan` | Round, soft moe faces. Bright and cartoon-like, character-focused |
| `ebifurya` | Clean cel shading, crisp color. Tidy anime-key-art feel |
| `karory` | Pastel with soft gradients, sparkling eyes. Sweet and gentle |
| `mignon` | Realistic skin texture and lighting, dreamy palette. Strong atmosphere |
| `asou (asabu202)` | Slice-of-life with living backgrounds. Natural light, calm color |
| `sweetonedollar` | Bloom-heavy light and warm tones. Emotive single-frame feel |
| `wantan meo` | Fresh saturation, casual and lively framing |
| `dikko` | Poppy color with strong highlights. Bold, confident lines |
| `hews` | Western-style volumetric shading, thick painterly rendering |
| `yomu (sgt epper)` | Dense clothing and fabric detail. Office-lady / pantyhose territory |
| `pochi (pochi-goya)` | Thick lines, voluptuous figures, warm tones |
| `sumiyao (amam)` | Neat lines and clear color. Clean, understated finish |
| `ame (uten cancel)` | Soft watercolor bleed, muted palette |

> These descriptions are rough direction, not exact. The fastest way to choose is to fix one prompt and swap only the artist tag across a few generations.

### Examples

```
sensitive, 1girl, @ningen mame, solo, short black hair, red ribbon, sailor uniform,
sitting, warm afternoon light, upper body. She is reading a book in a library.
```

```
questionable, 1girl, @rurudo, solo, white hair, red eyes, black jacket, neon signs,
rain, night city, looking at viewer, from below, cowboy shot
```
