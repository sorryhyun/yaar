# Fix: `solid-js/html` closing tag expression desync

## Problem

Apps using `solid-js/html` tagged template literals crash with:
```
Cannot read properties of undefined (reading 'keyed')
```

## Root Cause

When an app writes:
```js
html`<${Show} when=${() => cond()}>child</${Show}>`
```

The tagged template literal produces **3 expressions**: `[Show, () => cond(), Show]`.

But `solid-js/html`'s runtime parser only consumes **2** — the closing tag `</${Show}>` becomes `</<!--#-->>` internally, which the HTML tag regex swallows without incrementing the expression counter.

This shifts **all subsequent expression indices** by 1 per closing component tag. Eventually a component function (like `Show`) lands in a slot expecting a string, and gets called as `Show(undefined)` → `undefined.keyed` → crash.

## Affected pattern

Any `</${Component}>` closing tag with an expression:
```js
</${Show}>    // consumes an exprs[] slot the parser ignores
</${For}>
</${Switch}>
```

## Fix: compiler-level transform

In `packages/server/src/lib/compiler/index.ts`, after `compileWithBun()` returns the bundled JS, post-process the output to strip expressions from closing component tags in tagged template literals.

The transform target: in the bundled output, tagged template literals look like:
```js
html`...<${H} when=${()=>cond()}>child</${H}>...`
//    template strings:  ['...<', ' when=', '>child</', '>...']
//    expressions:       [H,      ()=>cond(),             H    ]  ← extra H
```

We need to merge the closing-tag template parts so the extra expression is removed:
```js
html`...<${H} when=${()=>cond()}>child</H>...`
//    template strings:  ['...<', ' when=', '>child</H>...']
//    expressions:       [H,      ()=>cond()              ]  ← correct
```

### Implementation sketch

Add a Bun plugin (`onLoad` for `.ts` files) or a post-bundle source transform:

```ts
/**
 * Strip expressions from closing tags in solid-js/html template literals.
 *
 * Matches the pattern:  </  ${expr}  >
 * Replaces with:        </>
 *
 * This is safe because solid-js/html's parser ignores closing tag names —
 * it only uses level-decrement, never matching open/close tag names.
 */
function stripClosingTagExpressions(source: string): string {
  // In a tagged template literal, `</${Comp}>` produces:
  //   ...template part ending with "</"
  //   expression (the component ref)
  //   template part starting with ">"
  //
  // After Bun bundles, this is still a tagged template literal in the output.
  // We can do a regex on the raw JS to find: `</` immediately before a
  // template expression boundary, and `>` immediately after.
  //
  // In the raw JS source (pre-bundle), this looks like:
  //   </${Show}>    inside a template literal
  //
  // In the bundled JS output, it looks like:
  //   </${H}>       (minified name)
  //
  // Strategy: match `</${...}>` inside template literals and replace with `</>`
  return source.replace(/<\/\$\{([^}]+)\}>/g, '</>');
}
```

Apply in `compileWithBun()` or as a new Bun `onLoad` plugin on `.ts` files:

```ts
// In compileWithBun(), after getting jsCode:
const jsCode = await compileWithBun(entryPoint, minify);
const fixedCode = stripClosingTagExpressions(jsCode);
// ... use fixedCode for HTML wrapper
```

**Or** as an `onLoad` plugin (transforms source before Bun bundles):

```ts
// In plugins.ts, new plugin:
export function solidHtmlClosingTagPlugin() {
  return {
    name: 'solid-html-closing-tag-fix',
    setup(build: any) {
      build.onLoad({ filter: /\.tsx?$/ }, async (args: any) => {
        const text = await Bun.file(args.path).text();
        if (!text.includes('</${')) return undefined; // fast skip
        return {
          contents: text.replace(/<\/\$\{([^}]+)\}>/g, '</>'),
          loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
        };
      });
    },
  };
}
```

### Which approach is better?

**`onLoad` plugin (pre-bundle)** is better because:
- Operates on readable source, not minified output
- Pattern `</${Show}>` is unambiguous in source
- Avoids risk of matching false positives in minified code

### Wiring it in

```ts
// compiler/index.ts — compileWithBun()
plugins: [bundledLibraryPluginBun(), cssFilePlugin(), solidHtmlClosingTagPlugin()],
```

## After the fix

All existing apps (`dock`, `image-viewer`, etc.) that use `</${Show}>` will work without any source changes. The AI can keep generating `</${Component}>` syntax naturally.
