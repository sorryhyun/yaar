# Lab

You drive Lab, a sandboxed compute notebook. JavaScript runs in a Web Worker inside the app;
you send code and receive **logs plus a size-capped result**. The whole point of this app is
that data stays in the sandbox: never write code whose purpose is to return a large data set
to you.

## The one rule

Compute inside the cell, return a conclusion. If the answer is "the 40 000 rows", write them
to storage and return the path — never the rows.

```
# wrong: pulls everything into the conversation
runCode({ code: "await store.readJSON('data/events.json')" })

# right: the reduction happens in the sandbox
runCode({ code: "const e = await store.readJSON('data/events.json');\ndf(e).groupBy('type').count().sortBy('count','desc').head(10)" })

# right: full result needed downstream, only the path comes back
runCode({ code: "df(rows).filter(r => r.score > 90)", saveResultTo: 'reports/top.csv' })
```

## runCode

`runCode({ code, timeoutMs?, resultLimit?, saveResultTo? })` runs code without creating a
cell. It returns:

- `ok`, `durationMs`
- `logs` — captured `console.log/warn/error`, capped at ~4 KB total
- `result` / `resultType` — the value of the **last expression**
- `truncated`, `shape` — when the result did not fit `resultLimit` (default 8192 bytes)
- `savedTo` — present when `saveResultTo` was given
- `error`, `stack` — when it threw

When the result is an array of objects, `resultType` is `table` and `result` is
`{ rowCount, columns, rows }` where `rows` is only the sample that fit. `rowCount` is the
truth about size; do not infer the total from `rows.length`.

`saveResultTo` takes any `store` path. `.csv` gets CSV, everything else pretty JSON.

## Execution model

- One persistent scope shared by `runCode` **and** the notebook's cells. `const`, `let`,
  `var`, `function` and `class` at the top level of a cell all survive into the next run,
  so you can set up in one call and query in the next.
- The last expression is the result, like a REPL. End with the value you want; a trailing
  `console.log` returns nothing.
- Top-level `await` is allowed.
- Default timeout 30 s. On timeout **the worker is killed and the scope is wiped** — the
  error message says so. Same for `resetKernel`.
- Only one execution runs at a time; calls queue.

## Helpers available in every cell

### store — app and shared storage

```js
await store.read(path)            // text
await store.readJSON(path)
await store.readCSV(path, opts?)  // -> array of objects
await store.write(path, data)     // string as-is; array + .csv -> CSV; else JSON
await store.writeCSV(path, rows)
await store.list(dir)             // [{ path, isDirectory, size, modifiedAt }]
await store.remove(path)
await store.exists(path)
```

Path rules:

| path | goes to |
|---|---|
| `notes/x.json` (default) | this app's private storage |
| `media/lab/x.png` | the shared media tree, where other apps can read it |
| `yaar://storage/media/...` | same, absolute form |

Writing a base64 `data:` URL stores real bytes, so
`store.write('media/lab/c.png', await plot.toPNG())` produces a usable image.

### df — mini dataframe

`df(rows)` wraps an array of objects. Every method returns a new `df`; `.rows` is the plain
array.

```js
df(rows)
  .filter(r => r.amount > 0)
  .assign({ net: r => r.amount - r.fee })
  .sortBy('net', 'desc')
  .head(20)
```

`filter map forEach slice head tail limit concat reduce at count columns column values
sortBy(key|fn, 'asc'|'desc') pick(cols) drop(cols) rename({old:new}) assign({col:fn})
distinct(key?) groupBy(key|keys[]|fn) agg(spec) join(other, leftKey, rightKey?, {how})
describe() toCSV() toArray()`

`groupBy(...)` returns a group handle: `.agg(spec)`, `.count(name?)`, `.map((rows,key)=>row)`,
`.get(key)`, `.keys`, `.size`.

`agg` spec values are `'sum' 'mean' 'min' 'max' 'median' 'stdev' 'count' 'countDistinct'
'first' 'last' 'list' 'join'` or a function `(groupRows) => value`. The output column takes
the spec key's name:

```js
df(sales).groupBy('region').agg({ amount: 'sum', order: 'count' })
// -> [{ region, amount, order }]
```

`join` is inner by default; pass `{ how: 'left' }` for a left join. Left-hand fields win on
key collisions.

### csv

`csv.parse(text, { header = true, delimiter = ',', cast = true })` — RFC-4180 quoting,
embedded newlines, BOM. `cast` converts numeric/boolean strings but leaves leading-zero
strings alone.
`csv.stringify(rows, { columns?, header = true, delimiter, eol })`.

### stats

`sum mean median min max count variance stdev quantile(arr, q) corr(a, b) histogram(arr, bins)`.
All ignore non-numeric entries. `histogram` returns `[{ bin, x0, x1, count }]`, ready to plot.

### plot — charts

`plot.line/area/bar/barh/scatter/pie/doughnut/hist(data, opts)` returns a chart spec. Make it
the last expression of a **cell** and it renders in the UI.

```js
plot.bar(byRegion, { x: 'region', y: 'amount', title: 'Sales by region', yLabel: 'KRW' })
plot.line(pivot, { x: 'month' })          // every numeric column becomes a series
plot.pie(rows, { x: 'label', y: 'value' })
```

`opts`: `x y (string or string[]) title xLabel yLabel stacked horizontal fill legend height
colors beginAtZero labels label bins`. With no `x`/`y`, the first non-numeric column becomes
the x axis and every numeric column becomes a series.

To hand a chart to another app:

```js
await plot.save(spec, 'media/lab/sales.png', { width: 800, height: 400 })
// -> { path, uri, bytes }
await plot.toPNG(spec)   // data URL, if you need the bytes in-cell
```

Or, for a chart already rendered in a cell, use the `exportChart` command.

### misc

`show(x)` adds an extra output block to a cell. `md(text)` adds rendered markdown.
`sleep(ms)`. `http.json(url)` / `http.text(url)` / `http.raw(url, init)` for network calls
(proxied, allowlisted).

## Notebook commands

Use these when the work should be **visible and re-runnable** by the user. Use `runCode`
for throwaway questions.

- `addCell({ source, type?, index? })` -> `{ id, index }`. Does not run it.
- `updateCell({ id, source, type? })`, `deleteCell({ id })`, `moveCell({ id, delta })`
- `runCell({ id, timeoutMs? })` -> a summary, never the data
- `runAll({ timeoutMs? })` -> one summary per code cell, stopping at the first failure
- `newNotebook({ title })`, `openNotebook({ id })`, `saveNotebook({ title? })`, `listNotebooks()`
- `exportChart({ cellId?, path?, width?, height?, background? })` -> saves a PNG under
  `media/lab/` and returns the path. Omit `cellId` for the newest chart in the notebook.
- `resetKernel()` — restart the worker, clearing every variable.

Read `currentNotebook` for cell ids and sources; it deliberately excludes outputs. Read
`lastRun` for the summary of the most recent execution.

## Building a notebook for a user

1. `newNotebook({ title })`
2. A markdown cell explaining the question, then one code cell per step — load, reshape,
   summarise, plot. Small cells; each ends in the value worth seeing.
3. `runAll()` and check the summaries.
4. `exportChart` if the chart is going somewhere else.

Do not paste a whole analysis into a single cell. The notebook is the artifact the user
keeps.

## Anti-patterns

- Returning raw rows "to check the data". Return `df(rows).head(3).rows` or `.describe()`.
- Re-reading a file in every cell. Read once; the variable persists.
- Assuming state survived a timeout, a `resetKernel`, or a window reload. It does not — if
  a variable is missing, re-run the setup.
- `store.write` to a `media/` path for private scratch data. `media/` is shared and visible;
  default (app-scoped) paths are not.
