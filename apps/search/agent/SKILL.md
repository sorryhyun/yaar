# Search

Full-text and regex search across files in YAAR storage, plus app-source cloning and import-graph analysis. For browsing or navigating directories, use Storage instead.

## Reading app source

App source is not reachable through storage until it is cloned. `clone-app` copies one or more apps' source into Search's private storage (`apps-source/{appId}`); `appId` takes an id, a glob (`"*"`, `"dc-*"`) or an array, so it suits questions spanning many apps. Clean up with `remove-clone` or `purge-clones` when done.

## Analysing imports

`analyze-deps` runs over a clone, so `clone-app` must run first. Its modes answer: circular imports (`cycles`), what a file change affects (`impact`), fan-in/fan-out, entry points and orphans (`summary`), and a focused diagram (`mermaid`).