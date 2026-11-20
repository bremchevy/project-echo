# PROJECT: ECHO

Executable event sourcing and NPC epistemic memory on Node 20, TypeScript, PostgreSQL 16, Prisma, Zod and Vitest. No language model or external service is involved in belief resolution or dialogue.

## Install and run

```sh
# Install nvm first if Node is not installed: https://github.com/nvm-sh/nvm
nvm install
nvm use
cp .env.example .env
npm ci
npx prisma generate
npm run db:up
npm run db:migrate
npm run typecheck
npm test
npm run scenario
```

Docker Compose is required. PostgreSQL binds only to localhost:54329. Credentials in the example are local development credentials, not deployment credentials. The scenario uses a fresh Daniel identity on each invocation, retains its events, and prints his answer alongside objective truth.

For a completely clean test database:

```sh
docker compose down -v
docker compose up -d --wait
npm run typecheck
npm test
```

**Tests are destructive:** integration tests TRUNCATE all three domain tables. Never point the test process at production or shared data. Global setup deploys the committed SQL migration against DATABASE_URL; there is no mocked persistence. Tests execute serially across files, but concurrency cases use Promise.all with independent interactive database transactions.

If Docker Hub rate-limits the PostgreSQL pull:

```sh
docker pull mirror.gcr.io/library/postgres:16
docker tag mirror.gcr.io/library/postgres:16 postgres:16
npm run db:up
```

## Layout

```text
prisma.config.ts                   Migration connection configuration
prisma/schema.prisma              Events, streams, npc_state
prisma/migrations/                SQL tables, uniqueness constraints, immutable trigger
src/database.ts                   PostgreSQL Prisma driver adapter
src/domain.ts                     Zod events, memory versions, pure reducer/beliefs/dialogue
src/store.ts                      Transactional processor, CAS, deduplication, reconstruction
src/scenario-data.ts              Reusable Daniel narrative
src/scenario.ts                   Executable narrative demonstration
tests/setup.ts                    Real migrate-deploy global setup
tests/integration.test.ts         PostgreSQL integration assertions
tests/domain.test.ts              Pure domain unit assertions
docker-compose.yml               PostgreSQL 16 with persistent volume
TEST_REPORT.md                    Unedited captured verification transcripts
```

## Domain and invariants

- Objective facts are WorldEventOccurred records on the world stream. They never enter Daniel's accessible memory automatically. Observations and faction testimony enter only via explicit NPC commands.
- A proposition is a subject/predicate/object tuple plus polarity. propositionKey returns its canonical tuple representation. The dialogue context's question is this **structured proposition key**, not free-form natural-language parsing. Unknown keys yield uncertainty with no invented citations.
- Every memory retains its original version and a source/provenance chain. MemoryModified appends a linked version with the hack actor/method; it preserves the original source and perceived evidence kind. accessible(state) exposes only current recollections, never manipulation metadata. The forensic state retains every version. Beliefs are separate derived personal-belief records with supporting and contradicting memory/version references; the memory type vocabulary also distinguishes objective and belief records from observations, testimony and external modifications.
- The pure resolver sums log-odds in sorted memory-ID order. Physical observations have reliability 0.95; testimony uses faction trust, defaulting to 0.65. FactionInteraction changes trust in the NPC's source map. Trust is bounded to [0.01, 0.99] by the command schema. Positive/negative polarities contribute signed evidence. Probabilities are rounded to eight decimals; at least 0.7 means believes_true, at most 0.3 means believes_false, otherwise uncertain. Opposing evidence is never discarded.
- Manipulated recollections receive their apparent evidence weight, not omniscient hack detection. Daniel therefore can sincerely believe a false proposition after a neural write. This is deliberate.
- Dialogue is a pure template function over current beliefs and accessible recollections. SHA-256 of canonical accessible state and dialogue context chooses wording; seed is optional. It does not consult the world log, forensic hack history, wall clock, or randomness.
- The store supplies timestamps and UUIDs outside reducers, with injectable clock/id factories. Events validate both on append and on read. rebuildFromLog folds NPC events in stream-version order without consulting projections or world truth.

## Transaction protocol

EventStore.append accepts an aggregate ID (world, npc:<id>, faction:<id>), expectedVersion, globally unique idempotencyKey, validated event, and actor/causation/correlation metadata. A command may produce both its primary event and processor-owned BeliefStateTransitioned records, so use the **last returned event version** for the next command rather than assuming each command advances by one.

1. Acquire a PostgreSQL transaction-scoped advisory lock for the idempotency key. Hash collisions only serialize unrelated requests; they do not identify them as duplicates.
2. If the exact key exists, validate and return the stored primary/derived events with duplicate: true. No stream or projection is changed. Reusing a key with a different stream/payload is an error. Interrogation compares its request context because answers are processor-generated.
3. Insert the stream if absent; conditionally lock/check its expected version. A stale writer receives typed ConcurrencyError with expected/actual versions.
4. Apply the memory/trust command, recompute beliefs, emit belief transitions as needed, and generate interrogation output from the current state (caller-provided answer fields are not trusted).
5. CAS the stream to expected+n, insert immutable events, and upsert npc_state with the same final version **in the same PostgreSQL transaction**.

Unique aggregate/version and idempotency constraints provide additional defenses. Derived idempotency keys use a reserved :derived: namespace; callers may not use it. A database trigger rejects UPDATE and DELETE on events even outside the application. TRUNCATE is intentionally available for isolated test reset. Rebuild returns state rather than mutating a live projection, avoiding a replay/write race.

## Deployment boundaries

This is a core library and CLI, not an authenticated public HTTP service. Production callers must authorize actors and neural writes, isolate NPC/world/faction command permissions, configure connection pooling/timeouts, protect DATABASE_URL, and use a DB role without TRUNCATE/DDL/trigger-disable privileges. No event payload is treated as executable code. Log retention/backup and encryption policy remain deployment responsibilities.

The dependency lockfile is committed. An effect patch override removes the transitive Prisma config advisory; npm audit reports zero vulnerabilities in the verified install. Prisma's transitive development-only local-stream tool declares Node >=22 and npm emits EBADENGINE on Node 20; the application, migration, generator, scenario and tests here all run on Node 20.20.2. That tool is not used by these scripts. Prisma itself supports Node >=20.19.

See TEST_REPORT.md for both the initial failing test fixture and the final clean-database passing run, captured verbatim.
