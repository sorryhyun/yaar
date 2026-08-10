# Lab — the sandbox scope

Lab runs JavaScript in a Web Worker inside its own window and hands back **logs plus a
size-capped result**. Its purpose is that the data stays in the sandbox: send it a
question, get a conclusion, and keep the 40 000 rows out of every context between here
and there.

## When to reach for it

When the work is arithmetic over data rather than a change to code — aggregating a large
log/JSON/CSV file, scanning for a pattern with more hits than are worth reading, deriving
stats, rendering a chart. When the result is "the rows themselves", write them to storage
inside the cell and let the path come back instead.

Not for probing an HTTP API on another app's behalf, and not as a general scripting
door: an app that needs a request of its own should declare `yaar://http` and make it.
Lab's `http` is here because a cell that loads a remote CSV should not have to leave the
sandbox to get it.

## The helpers in every cell

**This is the part no manifest can carry.** The commands below are protocol; these are
plain JavaScript globals inside the kernel scope, so they never appear in a command
schema — and an app driving Lab from outside has no other way to learn their signatures.
Calling `http.get(...)` and reading the `is not a function` back is the cost of guessing.

Scope persists across every execution — `const`, `let`, `function` and `class` declared at
a cell's top level survive into the next run, so setup and query can be separate calls.
The **last expression is the result**, REPL-style; top-level `await` is allowed.

### store — this app's storage, and the shared tree

```js
await store.read(path)              // text
await store.readJSON(path)
await store.readCSV(path, opts?)    // -> array of objects
await store.write(path, data)       // string as-is; array + .csv -> CSV; else JSON
await store.writeJSON(path, data)
await store.writeCSV(path, rows)
await store.list(dir)               // [{ path, isDirectory, size, modifiedAt }]
await store.remove(path)
await store.exists(path)
```

A bare path (`notes/x.json`) is always Lab's own private storage. Shared storage takes a
URI: `yaar://storage/media/lab/x.png`, or the `shared:` shorthand. `..` is refused in
every form — leave app storage with a URI, not traversal.

### http — proxied, allowlisted requests

```js
await http.raw(url, init)   // -> { ok, status, statusText, headers, body }
await http.text(url, init)  // -> the body string
await http.json(url, init)  // -> JSON.parse of the body
```

All three take `(url, init)` where `init` is the familiar `{ method, headers, body }`.
There is no `get`/`post` — the method goes in `init`. Requests are proxied server-side, so
the domain needs the user's allowlist approval and a denial arrives as a thrown error
naming it.

### df — mini dataframe

`df(rows)` wraps an array of objects; every method returns a new `df`, and `.rows` is the
plain array back.

```js
df(rows).filter(r => r.amount > 0).sortBy('amount', 'desc').head(20)
df(sales).groupBy('region').agg({ amount: 'sum', order: 'count' })
```

`filter map forEach slice head tail limit concat reduce at count columns column values
sortBy(key|fn, 'asc'|'desc') pick(cols) drop(cols) rename({old:new}) assign({col:fn})
distinct(key?) groupBy(key|keys[]|fn) agg(spec) join(other, leftKey, rightKey?, {how})
describe() toCSV() toArray()`

`groupBy(...)` returns a handle with `.agg(spec)`, `.count(name?)`,
`.map((rows, key) => row)`, `.get(key)`, `.keys`, `.size`. Aggregation specs are
`'sum' 'mean' 'min' 'max' 'median' 'stdev' 'count' 'countDistinct' 'first' 'last' 'list'
'join'` or a `(groupRows) => value` function. `join` is inner unless given
`{ how: 'left' }`.

### csv, stats

`csv.parse(text, { header = true, delimiter = ',', cast = true })` and
`csv.stringify(rows, { columns?, header = true, delimiter, eol })` — RFC-4180 quoting,
embedded newlines, BOM.

`sum mean median min max count variance stdev quantile(arr, q) corr(a, b)
histogram(arr, bins)` — all ignore non-numeric entries; `histogram` returns
`[{ bin, x0, x1, count }]`, ready to plot.

### plot

`plot.line/area/bar/barh/scatter/pie/doughnut/hist(data, opts)` returns a chart spec. As a
cell's last expression it renders in the window; `await plot.save(spec, path, { width,
height })` writes a PNG and returns `{ path, uri, bytes }`, and `await plot.toPNG(spec)`
gives a data URL.

`opts`: `x y (string or string[]) title xLabel yLabel stacked horizontal fill legend
height colors beginAtZero labels label bins`. With no `x`/`y`, the first non-numeric
column becomes the x axis and every numeric column a series.

### misc

`show(x)` adds an extra output block to a cell, `md(text)` adds rendered markdown, and
`sleep(ms)` waits.

## Ordering, and what surprises callers

Executions are serialized — one at a time, the rest queue. The default timeout is 30
seconds, and **a timeout kills the worker and wipes the scope**, as does resetting the
kernel: variables built up over several calls are gone, not stale. Rebuild before
assuming a name still resolves.

Everything run over the protocol is logged to the window's **Agent runs** view, where the
user sees the source, the logs, the rendered result and the duration. Running code
without a cell switches the window to that view; running a cell leaves the user on the
notebook. So a last expression worth *looking* at — a `head(10)` table, a chart — is
worth more than a bare count at no extra cost.

Use the notebook commands when the work should stay visible and re-runnable by the user,
and the one-off execution when the question is throwaway.
