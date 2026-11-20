# Test report

Environment: Ubuntu, Node v20.20.2, npm 10.8.2, PostgreSQL 16 in Docker.

All output blocks below are copied verbatim from captured stdout/stderr; no lines inside them have been edited. The initial failure was a test fixture that accidentally spread testimony-only fields into a strict faction event. The fixture was corrected, not the validation behavior. Final checks ran after docker compose down -v and docker compose up -d --wait, including migration deployment by Vitest global setup.

## Initial test run (exit 1)

```text

> project-echo@1.0.0 test
> vitest run


 RUN  v4.1.12 /home/ubuntu/repos/project-echo

Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "echo", schema "public" at "localhost:54329"

1 migration found in prisma/migrations

Applying migration `202611190001_init`

The following migration(s) have been applied:

migrations/
  └─ 202611190001_init/
    └─ migration.sql
      
All migrations have been successfully applied.
 ❯ tests/integration.test.ts (12 tests | 1 failed) 728ms
     × validates events on append and read, rejecting key reuse 28ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/integration.test.ts > Daniel integration > validates events on append and read, rejecting key reuse
AssertionError: expected [Function] to throw error including 'Idempotency key reused' but got '[\n  {\n    "code": "unrecognized_key…'

- Expected
+ Received

- Idempotency key reused
+ [
+   {
+     "code": "unrecognized_keys",
+     "keys": [
+       "memoryId",
+       "claim"
+     ],
+     "path": [],
+     "message": "Unrecognized keys: \"memoryId\", \"claim\""
+   }
+ ]

 ❯ tests/integration.test.ts:92:123
     90|     const result = await store.append(c);
     91|     expect(()=>readEvent({...result.events[0],payload:{type:'Invalid'}…
     92|     await expect(store.append({...c,event:{...c.event,type:'FactionInt…
       |                                                                                                                           ^
     93|   });
     94| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 18 passed (19)
   Start at  00:57:27
   Duration  2.09s (transform 50ms, setup 0ms, import 175ms, tests 738ms, environment 0ms)

```

## Final typecheck (exit 0)

```text

> project-echo@1.0.0 typecheck
> tsc --noEmit

```

## Final clean-database test run (exit 0)

```text

> project-echo@1.0.0 test
> vitest run


 RUN  v4.1.12 /home/ubuntu/repos/project-echo

Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Datasource "db": PostgreSQL database "echo", schema "public" at "localhost:54329"

1 migration found in prisma/migrations

Applying migration `202611190001_init`

The following migration(s) have been applied:

migrations/
  └─ 202611190001_init/
    └─ migration.sql

All migrations have been successfully applied.

 Test Files  2 passed (2)
      Tests  21 passed (21)
   Start at  01:00:13
   Duration  3.07s (transform 52ms, setup 0ms, import 208ms, tests 1.03s, environment 0ms)

```

## Scenario (exit 0)

```text

> project-echo@1.0.0 scenario
> tsx src/scenario.ts

Faction A accuses the player. Faction B denies it. Daniel sees exonerating evidence.
The player hacks that observation into an incriminating recollection.
Daniel: As I recall, i am confident: believes_true.
Objective truth: the assassin committed the murder; the player is innocent.
Forensic memory versions: [
  {
    id: '36b8da34-9357-4d92-96bc-b3f4efa23cba',
    kind: 'observation',
    claim: {
      object: 'victim',
      subject: 'player',
      polarity: false,
      predicate: 'murdered'
    },
    source: 'physical-evidence',
    version: 1,
    versionId: '7d55e627-501a-4bd2-9ace-ed5886e136cb',
    provenance: [ [Object] ],
    perceivedKind: 'observation'
  },
  {
    id: '36b8da34-9357-4d92-96bc-b3f4efa23cba',
    kind: 'external_modification',
    claim: {
      object: 'victim',
      subject: 'player',
      polarity: true,
      predicate: 'murdered'
    },
    source: 'physical-evidence',
    version: 2,
    versionId: '3f9fac48-6dc9-4409-9fef-b15d2384d715',
    provenance: [ [Object], [Object] ],
    perceivedKind: 'observation',
    previousVersionId: '7d55e627-501a-4bd2-9ace-ed5886e136cb'
  }
]
```

## Installation notes

Docker Hub returned HTTP 429; PostgreSQL 16 was pulled from mirror.gcr.io/library/postgres:16 and tagged locally as postgres:16. npm audit after the effect override reported `found 0 vulnerabilities`. npm install emitted the following upstream transitive development-tool engine warning; the loaded runtime was verified as Node 20.20.2 and every script used here executed successfully:

```text
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@prisma/streams-local@0.1.11',
npm warn EBADENGINE   required: { bun: '>=1.2.0', node: '>=22.0.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
```
