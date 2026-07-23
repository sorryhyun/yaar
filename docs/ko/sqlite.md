# 앱 스토리지를 위한 SQLite (`appDb`)

> [English version](../guides/sqlite.md)

`appDb`는 앱을 위한 구조화된 스토리지 레이어입니다: 앱마다 하나의 SQLite 데이터베이스를 두고
이를 컬렉션 API로 노출합니다. `packages/server/src/db/`(AppDatabase, pool, query builder)에
위치하며, `handlers/apps.ts`의 `yaar://apps/{appId}/db/*` 동사로 라우팅되고, 앱에서는
`import { appDb } from '@bundled/yaar'`(컴파일러 shim, `createReactiveCollection` 포함)로
노출됩니다.
사용법 문서: [app-development.md](./app-development.md#앱-전용-데이터베이스-appdb).

## 동기

`appDb` 이전에는 앱이 `storage/apps/{appId}/` 아래에 평면 파일로만 데이터를 저장했습니다. 이 방식은 동작은 하지만 앱이 할 수 있는 일을 제한합니다:

- **쿼리 불가** — 앱은 필터/검색을 위해 JSON 파일 전체를 메모리로 불러옵니다
- **트랜잭션 불가** — 여러 파일에 걸친 쓰기가 부분적으로 실패할 수 있습니다
- **구조화된 데이터 불가** — 모든 것이 직렬화된 JSON 문자열입니다
- **검색 불가** — `storageGrep`은 원본 텍스트 파일에 정규식을 적용합니다(파일당 O(n))
- **집계 불가** — 개수 세기, 합산, 그룹화에 전체 데이터 로드가 필요합니다

Bun에는 `bun:sqlite`가 내장되어 있습니다 — 의존성 없음, WAL 모드, 빠름. `appDb`는 기존 파일시스템 API를 그대로 유지하면서 앱을 위한 구조화된 스토리지 레이어로 SQLite를 추가합니다.

---

## 파일시스템 스토리지 (`appStorage`)

`appDb`는 파일 기반 `appStorage` API와 나란히 존재하며, 이 API는 바이너리 blob과 단순한 단일 파일 상태에는 여전히 옳은 선택입니다.

### 파일 기반 스토리지 패턴

| 패턴 | 앱 | 예시 |
|---------|------|---------|
| 단일 JSON 파일 (전체 로드, 전체 저장) | memo | `appStorage.save('memos.json', JSON.stringify(all))` |
| `createPersistedSignal` (자동 저장 시그널) | falling-blocks, dc-comics | `createPersistedSignal('settings.json', defaults)` |
| 디렉터리 안의 여러 파일 | devtools (프로젝트 파일), anima (생성된 프레임) | `appStorage.save('projects/abc/main.ts', code)` |
| base64를 통한 바이너리 | anima (PNG 프레임), image-edit (이미지 blob) | `appStorage.save(path, btoa(data), { encoding: 'base64' })` |

### SDK 표면 (`@bundled/yaar`)

```typescript
appStorage.save(path, content, options?)   // write text or base64
appStorage.read(path)                      // read as text
appStorage.readJson<T>(path)               // read + JSON.parse
appStorage.readJsonOr<T>(path, fallback)   // read + parse + fallback
appStorage.readBinary(path)                // → { data: base64, mimeType }
appStorage.readBlob(path)                  // → Blob
appStorage.list(dirPath?)                  // → [{ path, isDirectory, size, modifiedAt }]
appStorage.remove(path)                    // delete
```

### 서버 측 흐름

```
appStorage.save('notes.json', data)
  → iframe postMessage → verb SDK → POST /api/verb
  → invoke('yaar://apps/{appId}/storage/notes.json', { action: 'write', content: data })
  → apps handler → storageWrite('apps/{appId}/notes.json', data)
  → Bun.write('storage/apps/{appId}/notes.json', data)
```

---

## 설계 결정

### 1. 새로운 `appDb` API — `appStorage`를 대체하지 않음

**결정:** `appStorage` 옆에 새로운 `appDb` SDK를 추가합니다. 기존 API는 바꾸지 않습니다.

**이유:**
- 기존 앱들이 변경 없이 계속 동작합니다
- SQLite의 가치는 구조화된 쿼리에 있습니다 — 이를 파일 경로 API 뒤에 억지로 끼워 넣으면 그 능력을 낭비하게 됩니다
- 앱은 필요할 때 SQLite를 선택적으로 사용합니다; 단순한 앱은 `appStorage`에 그대로 남습니다
- `appStorage`가 나중에 투명하게 SQLite로 뒷받침될 수도 있지만(향후 작업), 사용자에게 보이는 API는 그대로 유지됩니다

### 2. 앱당 하나의 데이터베이스

**결정:** 각 앱은 `storage/apps/{appId}/data.db`를 갖습니다.

**이유:**
- 자연스러운 격리 (현재의 `storage/apps/{appId}/` 디렉터리와 동일)
- 앱이 실수로 다른 앱의 데이터를 읽을 수 없습니다
- 앱이 삭제될 때 지우기 쉽습니다
- SQLite는 하나의 거대 데이터베이스보다 목적이 좁은 데이터베이스에서 성능이 가장 좋습니다

### 3. `collections`를 이용한 schema-on-write

**결정:** 원시 SQL이 아니라 (MongoDB/Firestore와 같은) 컬렉션 기반 API를 사용합니다.

**이유:**
- LLM이 생성한 앱 코드는 원시 SQL보다 단순한 API에서 더 잘 동작합니다
- 컬렉션은 앱이 이미 하고 있는 일(JSON 파일 속 객체 배열)에 자연스럽게 대응합니다
- 서버가 검증과 인덱싱을 담당하므로 앱은 스키마를 관리할 필요가 없습니다
- 그럼에도 성능을 위해 실제 SQL 테이블로 뒷받침됩니다

### 4. 바이너리 데이터는 파일시스템에 유지

**결정:** `appDb`는 구조화된 데이터를 저장합니다. 바이너리 blob(이미지, PDF, XLSX)은 계속 `appStorage`를 사용합니다.

**이유:**
- 약 100KB를 넘는 SQLite blob은 성능을 해칩니다
- 바이너리 파일은 HTTP를 통해 직접 서비스되어야 합니다(`/api/storage/...`)
- 현재 바이너리를 저장하는 앱은 적으며 파일 API로도 잘 동작합니다

---

## 스키마 설계

### 내부 SQLite 스키마 (앱별 `data.db`)

```sql
-- One table per collection, created on first insert
-- Example: app calls appDb.collection('notes').insert({ title: 'Hi', body: '...' })
-- Server creates:

CREATE TABLE IF NOT EXISTS notes (
  _id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  _data TEXT NOT NULL,              -- JSON blob of the full document
  _created_at TEXT DEFAULT (datetime('now')),
  _updated_at TEXT DEFAULT (datetime('now'))
);

-- Auto-created FTS index per collection
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  _data,
  content=notes,
  content_rowid=rowid
);

-- Triggers to keep FTS in sync
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, _data) VALUES (new.rowid, new._data);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, _data) VALUES('delete', old.rowid, old._data);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, _data) VALUES('delete', old.rowid, old._data);
  INSERT INTO notes_fts(rowid, _data) VALUES (new.rowid, new._data);
END;
```

### 동적 컬럼 대신 `_data`에 JSON을 쓰는 이유

- 앱은 이질적인 문서를 다룹니다 — 모든 노트가 같은 필드를 갖는 것은 아닙니다
- SQLite의 JSON extract는 빠릅니다: `json_extract(_data, '$.title')`
- 새 필드가 생길 때마다 ALTER TABLE을 피할 수 있습니다
- 앱은 여전히 JSON 경로에 명시적 인덱스를 만들 수 있습니다:

```sql
CREATE INDEX IF NOT EXISTS notes_idx_tag ON notes(json_extract(_data, '$.tag'));
```

---

## SDK API 설계

### `appDb` — `@bundled/yaar`의 새 import

```typescript
import { appDb } from '@bundled/yaar';

// Get a collection handle (lazy — no network call)
const notes = appDb.collection<Note>('notes');

// Insert
const id = await notes.insert({ title: 'Hello', body: '...', tags: ['intro'] });

// Insert many
const ids = await notes.insertMany([{ title: 'A' }, { title: 'B' }]);

// Find by ID
const note = await notes.get(id);

// Find with filter
const results = await notes.find({ tags: 'intro' });

// Find with options
const page = await notes.find(
  { tags: 'intro' },
  { sort: { _created_at: -1 }, limit: 20, offset: 0 }
);

// Full-text search
const matches = await notes.search('hello world');

// Update
await notes.update(id, { title: 'Updated' }); // partial merge

// Delete
await notes.remove(id);

// Delete matching
await notes.removeWhere({ tags: 'draft' });

// Count
const n = await notes.count({ tags: 'intro' });

// List collections
const names = await appDb.collections();

// Drop collection
await appDb.drop('notes');
```

### 필터 문법

단순하고 LLM 친화적인 필터 객체:

```typescript
// Exact match
{ status: 'active' }

// Multiple conditions (AND)
{ status: 'active', priority: 'high' }

// Comparison operators
{ age: { $gt: 18 } }
{ score: { $gte: 90, $lt: 100 } }
{ name: { $ne: 'admin' } }

// Array contains
{ tags: 'intro' }                    // tag array contains 'intro'
{ tags: { $in: ['a', 'b'] } }       // tag is one of these

// Existence
{ avatar: { $exists: true } }
```

### `createReactiveCollection` — 반응형 Solid.js 바인딩

```typescript
import { appDb } from '@bundled/yaar';

// Reactive collection that auto-syncs with SQLite
const [notes, { insert, update, remove, refresh }] = appDb.createReactiveCollection<Note>(
  'notes',
  { sort: { _created_at: -1 }, limit: 50 }
);

// notes() is a Solid signal — rerenders on change
// insert/update/remove mutate SQLite then refresh the signal
// Backed by verb subscriptions: external writes (e.g. the agent) also trigger refresh
```

---

## 서버 측 구현

### 파일 구조

```
packages/server/src/
├── db/
│   ├── app-db.ts          # AppDatabase class (per-app SQLite wrapper)
│   ├── pool.ts            # Database pool (Map<appId, AppDatabase>), idle cleanup
│   ├── query-builder.ts   # Filter object → SQL WHERE clause
│   └── index.ts           # Barrel exports
```

### `AppDatabase` 클래스

```typescript
import { Database } from 'bun:sqlite';

class AppDatabase {
  private db: Database;
  private collections: Set<string>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.collections = this.loadCollectionNames();
  }

  ensureCollection(name: string): void { /* CREATE TABLE IF NOT EXISTS ... */ }
  insert(collection: string, doc: object): string { /* ... */ }
  get(collection: string, id: string): object | null { /* ... */ }
  find(collection: string, filter: object, options: FindOptions): object[] { /* ... */ }
  search(collection: string, query: string): object[] { /* FTS5 MATCH */ }
  update(collection: string, id: string, patch: object): boolean { /* ... */ }
  remove(collection: string, id: string): boolean { /* ... */ }
  count(collection: string, filter?: object): number { /* ... */ }
  drop(collection: string): void { /* DROP TABLE ... */ }
  close(): void { this.db.close(); }
}
```

### 데이터베이스 풀

```typescript
// Map<appId, { db: AppDatabase, lastAccess: number }>
// Idle timeout: 5 minutes (close db to free file handles)
// Max open: 20 databases (LRU eviction)
```

### URI 라우팅 — `yaar://apps/{appId}/db` 경로의 동사들

`read` 동사는 페이로드를 갖지 않으므로, 필터가 있는 조회는 `invoke { action: 'find' }`를
거칩니다; 컬렉션에 대한 평범한 `read`는 최근 문서를 반환합니다.

```
list('yaar://apps/{appId}/db')
  → collection names: ['notes', 'tags', ...]

read('yaar://apps/{appId}/db/{collection}')
  → recent documents: [{ _id, ...doc, _created_at, _updated_at }]

read('yaar://apps/{appId}/db/{collection}/{id}')
  → one document: { _id, ...doc, _created_at, _updated_at }

invoke('yaar://apps/{appId}/db/{collection}', { action, ... })
  → action: insert | insertMany | find | search | count | removeWhere
    e.g. { action: 'insert', doc: {...} }           → { _id: '...' }
         { action: 'find', filter, sort?, limit?, offset? } → [docs]
         { action: 'search', query: 'hello' }       → [{ _id, ...doc, rank }]

invoke('yaar://apps/{appId}/db/{collection}/{id}', { action: 'update', patch: {...} })
  → { updated: true }

delete('yaar://apps/{appId}/db/{collection}/{id}')
  → { deleted: true }

delete('yaar://apps/{appId}/db/{collection}')
  → { dropped: true }
```

### 쿼리 빌더: 필터 → SQL

```typescript
function buildWhere(filter: Record<string, unknown>): { sql: string; params: unknown[] } {
  // { status: 'active' }
  //   → "json_extract(_data, '$.status') = ?" [active]
  //
  // { age: { $gt: 18 } }
  //   → "json_extract(_data, '$.age') > ?" [18]
  //
  // { tags: 'intro' }  (array contains)
  //   → "EXISTS (SELECT 1 FROM json_each(json_extract(_data, '$.tags')) WHERE value = ?)" [intro]
}
```

---

## SDK Shim (`packages/compiler/src/shims/yaar.ts`)

`appDb`는 shim 안에서 `appStorage`와 나란히 있습니다(발췌 — `createReactiveCollection`을
포함한 전체 구현은 파일을 참조하세요):

```typescript
function appDbUri(path: string): string {
  return `yaar://apps/self/db/${path}`;
}

class CollectionHandle<T> {
  constructor(private name: string) {}

  async insert(doc: Omit<T, '_id'>): Promise<string> {
    const result = await y.invoke(appDbUri(this.name), { action: 'insert', doc });
    return result._id;
  }

  async get(id: string): Promise<T | null> {
    try {
      return await y.read(appDbUri(`${this.name}/${id}`));
    } catch { return null; }
  }

  async find(filter?: object, options?: FindOptions): Promise<T[]> {
    return y.invoke(appDbUri(this.name), { action: 'find', filter, ...options });
  }

  async search(query: string): Promise<T[]> {
    return y.invoke(appDbUri(this.name), { action: 'search', query });
  }

  async update(id: string, patch: Partial<T>): Promise<void> {
    await y.invoke(appDbUri(`${this.name}/${id}`), { action: 'update', patch });
  }

  async remove(id: string): Promise<void> {
    await y.delete(appDbUri(`${this.name}/${id}`));
  }

  async removeWhere(filter: object): Promise<number> {
    const result = await y.invoke(appDbUri(this.name), { action: 'removeWhere', filter });
    return result.deleted;
  }

  async count(filter?: object): Promise<number> {
    const result = await y.invoke(appDbUri(this.name), { action: 'count', filter });
    return result.count;
  }

  async insertMany(docs: Omit<T, '_id'>[]): Promise<string[]> {
    const result = await y.invoke(appDbUri(this.name), { action: 'insertMany', docs });
    return result.ids;
  }
}

export const appDb = {
  collection<T = Record<string, unknown>>(name: string): CollectionHandle<T> {
    return new CollectionHandle<T>(name);
  },
  async collections(): Promise<string[]> {
    return y.list(appDbUri(''));
  },
  async drop(name: string): Promise<void> {
    await y.delete(appDbUri(name));
  },
};
```

---

## 파일시스템 스토리지와의 공존

### 무엇이 어디에 저장되는가

| 데이터 유형 | 스토리지 | 이유 |
|-----------|---------|--------|
| 구조화된 레코드 (노트, 피드, 설정 객체) | `appDb` (SQLite) | 쿼리 가능, 트랜잭션 가능 |
| 사용자가 업로드한 파일 (이미지, PDF, XLSX) | `appStorage` (파일시스템) | 직접 HTTP 서빙, 큰 blob |
| 단순한 key-value 설정 | 둘 다 가능 | 단일 파일이면 `appStorage`, 키가 많으면 `appDb` |
| 앱 자격 증명/토큰 | `appStorage` (파일시스템) | 사람이 직접 열람 가능, 단순한 read/write |

### 충돌 없음 — 병렬 시스템

```
storage/apps/{appId}/
├── data.db              ← NEW: SQLite database (appDb)
├── draft.json           ← EXISTING: file storage (appStorage)  
├── auth/
│   └── credentials.json ← EXISTING: file storage (appStorage)
└── uploads/
    └── photo.png        ← EXISTING: file storage (appStorage)
```

두 API 모두 동시에 동작합니다. `appStorage`는 `data.db`를 건드리지 않습니다. `appDb`는 `data.db`만 건드립니다. 기존 앱에 대한 마이그레이션이 필요 없습니다.

### AI 에이전트 접근

AI 에이전트는 이미 5개의 범용 verb 도구를 사용합니다. 새로운 `yaar://apps/{appId}/db/` URI는 같은 핸들러에 등록되므로, 에이전트가 앱 데이터베이스를 직접 쿼리할 수 있습니다:

```
read('yaar://apps/memo/db/notes', { filter: { tags: 'important' }, limit: 5 })
```

이는 큰 개선입니다 — 이제 에이전트가 전체를 로드하지 않고도 앱 데이터를 검색하고 필터링할 수 있습니다.

---

## 구현 현황

**구현 완료:**
- 핵심 인프라 — `AppDatabase` 클래스, 풀, 쿼리 빌더(`packages/server/src/db/`),
  `yaar://apps/{appId}/db/*` verb 라우트(`handlers/apps.ts`), `appDb` + `CollectionHandle`
  SDK shim과 타입 선언(`packages/compiler/src/shims/yaar.ts`,
  `bundled-types/index.d.ts`)
- 전문 검색 — 동기화 트리거가 있는 FTS5 테이블, `collection.search(query)`
- 반응형 바인딩 — Solid.js를 위한 `appDb.createReactiveCollection`, verb 구독으로 뒷받침되어
  외부 쓰기(예: 에이전트)가 UI를 새로고침

**향후 작업:**
- **JSON 경로 인덱스** — `appDb.collection('notes').createIndex('$.tag')`
- **원시 SQL 탈출구** — 필터 문법으로 표현할 수 없는 쿼리를 위한 `appDb.raw(sql, params)`
- **백업/내보내기** — `appDb.export()` → JSON dump, `appDb.import(json)` → 복원
- **SQLite로 뒷받침되는 `appStorage`** — 파일 API를 SQLite KV 테이블로 투명하게 마이그레이션(비파괴적)
- **필터가 적용된 실시간 쿼리** — `appDb.collection('notes').subscribe(filter, callback)`

---

## 위험 요소와 완화 방안

| 위험 | 영향 | 완화 방안 |
|------|--------|------------|
| 동시 접근 시 SQLite 파일 잠금 | 앱 에이전트 + iframe이 동시에 쓰기 | WAL 모드가 동시 읽기를 처리; 쓰기는 db당 직렬화됨(단일 프로세스 서버) |
| 크래시 시 데이터베이스 손상 | 데이터 손실 | WAL + `PRAGMA synchronous=NORMAL` — 프로세스 크래시에서도 살아남음. 최악의 경우 WAL로부터 재구성 |
| 큰 데이터베이스가 앱 삭제 속도를 늦춤 | UX 지연 | 그냥 `rm data.db` — SQLite는 단일 파일 |
| 필터 문법이 너무 제한적 | 앱에 원시 SQL이 필요 | `appDb.raw(sql, params)` 탈출구 추가 가능(향후 작업) |
| 열린 데이터베이스로 인한 메모리 사용 | 서버 OOM | LRU eviction이 있는 풀(최대 20개 오픈, 5분 유휴 타임아웃) |
| 앱 shim에 대한 하위 호환성 깨짐 | 기존 앱이 깨짐 | 순수하게 추가적임 — `appDb`는 신규, `appStorage`는 변경 없음 |

---

## 예시: Memo 앱 (이전/이후)

### 이전 (파일시스템)

```typescript
import { appStorage } from '@bundled/yaar';

// Load ALL memos into memory
const raw = await appStorage.readJsonOr<Memo[]>('memos.json', []);
const [memos, setMemos] = createSignal(raw);

// Search = filter in memory
const results = memos().filter(m => m.title.includes(query));

// Save = serialize entire array
async function addMemo(memo: Memo) {
  setMemos(prev => [...prev, memo]);
  await appStorage.save('memos.json', JSON.stringify(memos()));
}
```

### 이후 (SQLite)

```typescript
import { appDb } from '@bundled/yaar';

const memos = appDb.collection<Memo>('memos');

// Search = server-side FTS
const results = await memos.search(query);

// Save = single insert
async function addMemo(memo: Memo) {
  await memos.insert(memo);
}

// Paginated list
const page = await memos.find({}, { sort: { _created_at: -1 }, limit: 20, offset: 0 });
```

더 이상 전체 로드-전체 저장이 아닙니다. 더 이상 메모리 내 필터링도 아닙니다. 수천 개의 레코드로 확장됩니다.
