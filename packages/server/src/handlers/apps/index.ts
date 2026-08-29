/**
 * Apps domain handlers for the verb layer.
 *
 * Maps app operations to the verb layer:
 *
 *   list('yaar://apps')                              → list all installed apps
 *   read('yaar://apps/{appId}')                      → generated reference doc
 *   invoke('yaar://apps/{appId}', { action, ... })   → set_badge | install | publish | clone
 *   delete('yaar://apps/{appId}')                    → uninstall app
 *
 * App-scoped storage:
 *   read('yaar://apps/{appId}/storage/{path}')       → read file
 *   list('yaar://apps/{appId}/storage/{dir}')        → list directory
 *   invoke('yaar://apps/{appId}/storage/{path}', ..) → write file
 *   delete('yaar://apps/{appId}/storage/{path}')     → delete file
 *
 * On disk: storage/apps/{appId}/{path}
 *
 * App-scoped database (SQLite collections, see docs/reference/app_db_reference.md):
 *   list('yaar://apps/{appId}/db')                          → collection names
 *   read('yaar://apps/{appId}/db/{coll}')                   → recent documents
 *   read('yaar://apps/{appId}/db/{coll}/{id}')              → one document
 *   invoke('yaar://apps/{appId}/db/{coll}', { action })     → insert | insertMany | find | search | count | removeWhere
 *   invoke('yaar://apps/{appId}/db/{coll}/{id}', { action })→ update
 *   delete('yaar://apps/{appId}/db/{coll}/{id}')            → remove document
 *   delete('yaar://apps/{appId}/db/{coll}')                 → drop collection
 *
 * On disk: storage/apps/{appId}/data.db
 *
 * App-owned persona agents (see docs/architecture/agent_tree.md):
 *   list('yaar://apps/self/agents')                              → roster
 *   invoke('yaar://apps/self/agents', { action: 'spawn', ... })  → spawn a persona
 *   invoke('yaar://apps/self/agents/{id}', { action, ... })      → message | interrupt
 *   read('yaar://apps/self/agents/{id}')                         → busy + last answer
 *   delete('yaar://apps/self/agents[/{id}]')                     → dispose one | all
 *
 * Structure — `register.ts` owns dispatch order and is the only file that knows the
 * subresources are a composite rather than separate registrations (the registry has
 * no middle wildcard); `app-resource.ts`, `storage-resource.ts`, `db-resource.ts`, and
 * `agents-resource.ts` own one resource each; `paths.ts` owns URI parsing and the
 * on-disk layout.
 */

export { registerAppsHandlers } from './register.js';
export { appStoragePath, scopedAppStoragePath } from './paths.js';
