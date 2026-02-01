# Action Reload System - Detailed Implementation Plan

## Vision

Enable ClaudeOS to cache AI-generated action sequences and replay them instantly when similar contexts reappear. This transforms repetitive interactions (clicking the same app, performing common operations) from expensive AI generations into instant replays.

**Example Flow:**
```
First time:
  User clicks Storage app → AI generates window (500ms-2s)

Second time:
  User clicks Storage app → System offers reload → Instant render (<50ms)
```

---

## Architecture Overview

```
                                    ┌─────────────────────┐
                                    │   ReloadCache       │
                                    │   ───────────────   │
                                    │   findMatches()     │
                                    │   recordSequence()  │
                                    │   replay()          │
                                    └─────────┬───────────┘
                                              │
User Input → ContextPool.handleTask() ────────┤
                    │                         │
                    ▼                         ▼
        ┌───────────────────────────────────────────────┐
        │  Inject <reload_options> into prompt          │
        │  if matching cached sequences found           │
        └───────────────────────────────────────────────┘
                    │
                    ▼
        AgentSession.handleMessage()
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
   AI uses               AI generates
   reload_cached()       new actions
        │                       │
        ▼                       ▼
   Replay cached        Record sequence
   actions instantly    for future reuse
```

---

## Key Design Decisions

### Decision 1: Cache Storage Strategy

#### Approach A: In-Memory Only (Simplest)
```typescript
class ReloadCache {
  private entries: Map<string, ReloadCacheEntry> = new Map();

  // Fast lookups, lost on restart
}
```

| Pros | Cons |
|------|------|
| Zero latency lookups | Lost on server restart |
| No disk I/O | No cross-session persistence |
| Simple implementation | Memory usage grows unbounded |

**Best for:** Development, testing, or when restarts are rare.

---

#### Approach B: File-Based Persistence (Recommended)
```typescript
class ReloadCache {
  private entries: Map<string, ReloadCacheEntry> = new Map();
  private persistPath = 'storage/reload-cache.json';

  async loadFromDisk() { /* ... */ }
  async saveToDisk() { /* debounced write */ }
}
```

| Pros | Cons |
|------|------|
| Survives restarts | Disk I/O on mutations |
| Simple JSON format | Single file = scaling limit |
| Uses existing storage patterns | Need to handle corruption |

**Implementation:**
- Load on `ContextPool.initialize()`
- Save debounced (500ms after last mutation)
- Max entries: 100 (LRU eviction)

---

#### Approach C: Per-Session Cache Files
```typescript
// session_logs/2026-01-31_12-00-00/
//   ├── messages.jsonl
//   ├── transcript.md
//   └── reload-cache.json  ← NEW
```

| Pros | Cons |
|------|------|
| Session-scoped isolation | More files to manage |
| Natural cleanup with session | Can't share across sessions |
| Atomic with session logs | |

**Best for:** When cache entries are session-specific (reference specific windowIds).

---

#### Approach D: SQLite Database
```typescript
// storage/claudeos.db
// Table: reload_cache (id, fingerprint_json, actions_json, metadata_json, created_at)
```

| Pros | Cons |
|------|------|
| Proper indexing for queries | Additional dependency |
| Handles large datasets | More complex setup |
| Atomic transactions | Overkill for simple caching |

**Best for:** Future scaling when cache grows large.

---

### **Recommendation:** Start with **Approach B** (file-based). Migrate to D if needed later.

---

### Decision 2: Context Fingerprinting Strategy

How do we identify "same context" to suggest cached responses?

#### Approach A: Trigger-Based Matching (Simplest)
```typescript
interface ContextFingerprint {
  triggerType: 'app_click' | 'button_click' | 'form_submit' | 'user_message';
  triggerTarget: string;  // e.g., "storage", "submit-button"
}

// Match: exact trigger type + target
function matches(a: ContextFingerprint, b: ContextFingerprint): boolean {
  return a.triggerType === b.triggerType && a.triggerTarget === b.triggerTarget;
}
```

| Pros | Cons |
|------|------|
| Very fast O(1) lookup | Only works for repeated identical triggers |
| Dead simple | Misses similar-but-not-identical contexts |
| Predictable behavior | No fuzzy matching |

**Best for:** App clicks, button clicks - deterministic triggers.

---

#### Approach B: N-Gram Similarity Matching (Recommended)
```typescript
interface ContextFingerprint {
  triggerType: string;
  triggerTarget: string;
  contextNgrams: string[];  // 2-grams and 3-grams
  windowStateHash: string;
}

function computeNgrams(text: string): string[] {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const ngrams: string[] = [];

  // 2-grams: ["user clicked", "clicked storage", "storage app"]
  for (let i = 0; i < words.length - 1; i++) {
    ngrams.push(`${words[i]} ${words[i + 1]}`);
  }

  // 3-grams: ["user clicked storage", "clicked storage app"]
  for (let i = 0; i < words.length - 2; i++) {
    ngrams.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }

  return ngrams;
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function computeSimilarity(a: ContextFingerprint, b: ContextFingerprint): number {
  let score = 0;

  // Exact trigger match: +50%
  if (a.triggerType === b.triggerType && a.triggerTarget === b.triggerTarget) {
    score += 0.5;
  }

  // N-gram similarity: +30%
  score += jaccardSimilarity(a.contextNgrams, b.contextNgrams) * 0.3;

  // Window state match: +20%
  if (a.windowStateHash === b.windowStateHash) {
    score += 0.2;
  }

  return Math.min(score, 1.0);
}
```

| Pros | Cons |
|------|------|
| Fuzzy matching for variations | More complex to implement |
| Works for similar contexts | Requires threshold tuning |
| Weighted scoring is flexible | O(n) comparison per lookup |

**Best for:** General-purpose matching across varied user inputs.

---

#### Approach C: Semantic Embedding Matching
```typescript
interface ContextFingerprint {
  triggerType: string;
  triggerTarget: string;
  embedding: number[];  // 384-dim sentence embedding
}

// Use a small local model (e.g., all-MiniLM-L6-v2)
async function computeEmbedding(text: string): Promise<number[]> {
  return await embeddingModel.encode(text);
}

function cosineSimilarity(a: number[], b: number[]): number {
  // Standard cosine similarity
}
```

| Pros | Cons |
|------|------|
| Semantic understanding | Requires embedding model |
| Handles paraphrasing | Slower computation |
| State-of-the-art matching | Extra dependency |

**Best for:** When n-gram matching isn't precise enough.

---

### **Recommendation:** Start with **Approach B** (n-gram). Add embedding later if needed.

---

### Decision 3: Cache Entry Structure

#### Approach A: Store Full Action Sequence (Recommended)
```typescript
interface ReloadCacheEntry {
  id: string;
  fingerprint: ContextFingerprint;
  actions: OSAction[];  // Full sequence
  summary: string;
  metadata: {
    createdAt: string;
    lastUsed: string;
    useCount: number;
    successCount: number;
    failureCount: number;
  };
}
```

| Pros | Cons |
|------|------|
| Supports partial replay | Larger storage |
| Easy to inspect/debug | Actions may reference stale state |
| Atomic replay | |

---

#### Approach B: Store Final Window State
```typescript
interface ReloadCacheEntry {
  id: string;
  fingerprint: ContextFingerprint;
  windowState: WindowModel[];  // End state of windows
  summary: string;
  metadata: { ... };
}
```

| Pros | Cons |
|------|------|
| Smaller storage | Loses action sequence info |
| Always consistent end state | Can't do partial replay |
| | Harder to diff against current state |

---

#### Approach C: Store Diff from Initial State
```typescript
interface ReloadCacheEntry {
  id: string;
  fingerprint: ContextFingerprint;
  initialStateHash: string;
  diff: WindowStateDiff[];  // Only what changed
  summary: string;
  metadata: { ... };
}
```

| Pros | Cons |
|------|------|
| Smallest storage | Complex diff logic |
| Can validate initial state matches | Fragile to state drift |
| | Harder to implement |

---

### **Recommendation:** Use **Approach A** (full action sequence). Simple and flexible.

---

### Decision 4: Reload Tool API Design

#### Approach A: Single Tool with Cache ID (Simplest)
```typescript
// Agent calls this when it wants to reload
server.registerTool('reload_cached', {
  description: 'Replay a cached action sequence instantly.',
  inputSchema: {
    cacheId: z.string(),
  }
}, async (args) => {
  const entry = cache.get(args.cacheId);
  if (!entry) return ok('Cache entry not found');

  for (const action of entry.actions) {
    actionEmitter.emitAction(action);
  }

  cache.recordUse(args.cacheId, true);
  return ok(`Replayed ${entry.actions.length} actions`);
});
```

| Pros | Cons |
|------|------|
| Simple API | Agent must know cache ID |
| Direct control | No discovery mechanism |

---

#### Approach B: Discovery + Reload Tools (Recommended)
```typescript
// List available reload options
server.registerTool('list_reload_options', {
  description: 'Show cached responses matching current context.',
  inputSchema: {}
}, async () => {
  const matches = cache.findMatchesForCurrentContext();
  return ok(formatMatches(matches));
});

// Replay specific cached response
server.registerTool('reload_cached', {
  description: 'Replay a cached action sequence.',
  inputSchema: {
    cacheId: z.string(),
    skipIndices: z.array(z.number()).optional(),
  }
}, async (args) => { /* ... */ });
```

| Pros | Cons |
|------|------|
| Agent can explore options | Two tools instead of one |
| Supports partial replay | |
| Clear separation of concerns | |

---

#### Approach C: Automatic Reload (Agent Doesn't Decide)
```typescript
// In ContextPool.processMainTask():
const matches = cache.findMatches(context);
if (matches.length > 0 && matches[0].similarity > 0.95) {
  // Auto-replay without AI involvement
  await cache.replay(matches[0].entry.id);
  return; // Skip AI entirely
}
```

| Pros | Cons |
|------|------|
| Fastest possible reload | User loses control |
| No token cost | May replay wrong content |
| | Hard to override |

---

#### Approach D: Hybrid - Auto + Agent Override
```typescript
// High confidence (>95%): Auto-replay with notification
// Medium confidence (70-95%): Show options to agent
// Low confidence (<70%): Generate fresh

const matches = cache.findMatches(context);
const topMatch = matches[0];

if (topMatch?.similarity > 0.95) {
  // Auto-replay
  await cache.replay(topMatch.entry.id);
  await notify('Loaded from cache: ' + topMatch.entry.summary);
} else if (matches.length > 0) {
  // Inject options for agent to decide
  contentWithOptions = formatReloadOptions(matches) + content;
}
```

| Pros | Cons |
|------|------|
| Best of both worlds | More complex logic |
| Fast for obvious cases | Need good threshold tuning |
| Agent control for ambiguous cases | |

---

### **Recommendation:** Start with **Approach B**. Consider D as an optimization later.

---

### Decision 5: Prompt Injection Strategy

How to inform the AI about available reload options?

#### Approach A: XML Block at Start (Recommended)
```xml
<reload_options>
Cached responses matching this context. Use reload_cached(id) to replay instantly:

1. [cache-abc123] "Opens storage browser" (95% match, 5 uses)
   Actions: window.create, window.setContent

2. [cache-def456] "Shows file listing" (82% match, 2 uses)
   Actions: window.create

TIP: Use reload for high-match entries to respond faster.
</reload_options>

User clicked on storage app icon.
```

| Pros | Cons |
|------|------|
| Clear structure | Uses tokens on every match |
| Easy to parse | May distract from task |
| Self-documenting | |

---

#### Approach B: Condensed Inline Hint
```
[RELOAD: cache-abc123 "storage browser" 95%] User clicked storage app.
```

| Pros | Cons |
|------|------|
| Minimal tokens | Less context for AI |
| Doesn't distract | Requires training |
| Fast to scan | |

---

#### Approach C: System Prompt Injection
```typescript
// In system prompt when cache has matches:
const systemPrompt = BASE_PROMPT + `

## Current Reload Options
- cache-abc123: "Opens storage browser" (95% match)

Use \`reload_cached("cache-abc123")\` to replay instantly.
`;
```

| Pros | Cons |
|------|------|
| Cleaner user message | System prompt grows |
| AI sees it every turn | Must update dynamically |

---

### **Recommendation:** Use **Approach A** (XML block). Clear and self-contained.

---

### Decision 6: Cache Invalidation Strategy

#### Time-Based Expiration
```typescript
const MAX_IDLE_HOURS = 24;

function isExpired(entry: ReloadCacheEntry): boolean {
  const lastUsed = new Date(entry.metadata.lastUsed);
  const hoursSinceUse = (Date.now() - lastUsed.getTime()) / (1000 * 60 * 60);
  return hoursSinceUse > MAX_IDLE_HOURS;
}
```

#### Failure-Based Removal
```typescript
const MAX_FAILURE_RATE = 0.5;  // 50% failure rate

function shouldRemove(entry: ReloadCacheEntry): boolean {
  const { successCount, failureCount } = entry.metadata;
  const total = successCount + failureCount;
  if (total < 3) return false;  // Need minimum sample
  return failureCount / total > MAX_FAILURE_RATE;
}
```

#### LRU Eviction
```typescript
const MAX_ENTRIES = 100;

function evictLRU(entries: Map<string, ReloadCacheEntry>): void {
  if (entries.size <= MAX_ENTRIES) return;

  const sorted = [...entries.entries()]
    .sort((a, b) =>
      new Date(a[1].metadata.lastUsed).getTime() -
      new Date(b[1].metadata.lastUsed).getTime()
    );

  const toRemove = sorted.slice(0, entries.size - MAX_ENTRIES);
  for (const [id] of toRemove) {
    entries.delete(id);
  }
}
```

#### Context Change Detection
```typescript
// Invalidate entries that reference deleted windows or changed state
function pruneStaleEntries(
  entries: Map<string, ReloadCacheEntry>,
  currentWindowIds: Set<string>
): void {
  for (const [id, entry] of entries) {
    const referencedWindows = entry.actions
      .filter(a => a.type.startsWith('window.'))
      .map(a => (a as any).windowId);

    const hasStaleReference = referencedWindows.some(
      wid => !currentWindowIds.has(wid)
    );

    if (hasStaleReference) {
      entries.delete(id);
    }
  }
}
```

---

## Implementation Plan

### Phase 1: Core Cache Module
**Files to create:**
- `packages/server/src/reload/types.ts` - Type definitions
- `packages/server/src/reload/fingerprint.ts` - N-gram matching
- `packages/server/src/reload/cache.ts` - ReloadCache class
- `packages/server/src/reload/index.ts` - Exports

### Phase 2: MCP Tools
**Files to create:**
- `packages/server/src/mcp/tools/reload.ts` - reload_cached, list_reload_options

**Files to modify:**
- `packages/server/src/mcp/tools/index.ts` - Register reload tools

### Phase 3: Integration
**Files to modify:**
- `packages/server/src/agents/context-pool.ts`
  - Create ReloadCache instance
  - Inject `<reload_options>` before processing
  - Record action sequences after completion

- `packages/server/src/agents/session.ts`
  - Track emitted actions during handleMessage
  - Expose getRecordedActions() method

### Phase 4: System Prompt
**Files to modify:**
- `packages/server/src/providers/claude/system-prompt.ts`
  - Add "Reload System" section explaining usage

---

## Type Definitions

```typescript
// packages/server/src/reload/types.ts

export type TriggerType =
  | 'app_click'
  | 'button_click'
  | 'form_submit'
  | 'user_message';

export interface ContextFingerprint {
  triggerType: TriggerType;
  triggerTarget: string;
  contextNgrams: string[];
  windowStateHash: string;
}

export interface ReloadCacheEntry {
  id: string;
  fingerprint: ContextFingerprint;
  actions: OSAction[];
  summary: string;
  metadata: {
    createdAt: string;
    lastUsed: string;
    useCount: number;
    successCount: number;
    failureCount: number;
    originalMessageId: string;
    agentId: string;
  };
}

export interface CacheMatch {
  entry: ReloadCacheEntry;
  similarity: number;
  matchReason: string;
}

export interface ReloadCacheConfig {
  maxEntries: number;       // Default: 100
  maxIdleHours: number;     // Default: 24
  minSimilarity: number;    // Default: 0.7
  autoReloadThreshold: number;  // Default: 0.95
  persistPath: string;      // Default: 'storage/reload-cache.json'
}
```

---

## Verification Plan

1. **Unit Tests:**
   - N-gram computation correctness
   - Jaccard similarity edge cases
   - Cache CRUD operations
   - Invalidation rules

2. **Integration Tests:**
   - Record → Match → Replay cycle
   - Persistence across restart
   - Concurrent access safety

3. **Manual Testing:**
   ```
   1. Start ClaudeOS: make dev
   2. Click Storage app → window created (observe generation time)
   3. Close window
   4. Click Storage app again
   5. Check logs for <reload_options> in prompt
   6. Verify AI uses reload_cached
   7. Observe instant window (no generation)
   8. Check storage/reload-cache.json for entry
   9. Restart server → repeat step 4 → verify cache persists
   ```

---

## Open Questions

1. **Scope granularity:** Should we cache at the message level or action-sequence level?
2. **Multi-window sequences:** How to handle sequences that create multiple windows?
3. **Content personalization:** What if cached content includes user-specific data?
4. **Replay conflicts:** What if replayed window ID already exists?
5. **Token budget:** Should we limit how many reload options we show?

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Cache hit rate for repeated actions | >80% |
| Reload latency vs generation | <100ms vs 500ms-2s |
| Cache size (steady state) | <1MB |
| AI reload acceptance rate | >90% when offered |

---

*Related: See `milestone_claude.md` Phase 3 (Context Persistence) for session-level caching.*
