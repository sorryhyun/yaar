# App Development Guide

## Sandbox Structure

Entry point is `src/main.ts`. Split code into multiple files (e.g., `src/utils.ts`, `src/renderer.ts`) and import them from main.ts — avoid putting everything in one file.

## Bundled Libraries

Available via `@bundled/*` imports (no npm install needed):

| Import | Description |
|--------|-------------|
| `@bundled/uuid` | Unique ID generation: `v4()`, `v1()`, `validate()` |
| `@bundled/lodash` | Utilities: `debounce`, `throttle`, `cloneDeep`, `groupBy`, `sortBy`, `uniq`, `chunk`, etc. |
| `@bundled/date-fns` | Date utilities: `format`, `addDays`, `differenceInDays`, `isToday`, etc. |
| `@bundled/clsx` | CSS class names: `clsx('foo', { bar: true })` |
| `@bundled/anime` | Animation library: `anime({ targets, translateX, duration, easing })` |
| `@bundled/konva` | 2D canvas graphics: `Stage`, `Layer`, `Rect`, `Circle`, `Text`, etc. |
| `@bundled/three` | 3D rendering engine: `Scene`, `Camera`, `Mesh`, `BoxGeometry`, `MeshStandardMaterial`, etc. |
| `@bundled/cannon-es` | 3D physics engine: `World`, `Body`, `Box`, `Sphere`, `Vec3`, `ContactMaterial`, etc. |

Example:
```ts
import { v4 as uuid } from '@bundled/uuid';
import anime from '@bundled/anime';
import { format } from '@bundled/date-fns';
```

## Storage API

Available at runtime via `window.yaar.storage` (auto-injected, no import needed):

| Method | Description |
|--------|-------------|
| `save(path, data)` | Write file (`string \| Blob \| ArrayBuffer \| Uint8Array`) |
| `read(path, opts?)` | Read file (`opts.as`: `'text' \| 'blob' \| 'arraybuffer' \| 'json' \| 'auto'`) |
| `list(dirPath?)` | List directory → `[{path, isDirectory, size, modifiedAt}]` |
| `remove(path)` | Delete file |
| `url(path)` | Get URL string for `<a>`/`<img>`/etc. |

Files are stored in the server's `storage/` directory. Paths are relative (e.g., `"myapp/data.json"`).

```ts
// Save
await yaar.storage.save('scores.json', JSON.stringify(data));
// Read
const data = await yaar.storage.read('scores.json', { as: 'json' });
// Get URL for display
const imgUrl = yaar.storage.url('photos/cat.png');
```
