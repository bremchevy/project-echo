# PROJECT: ECHO

PostgreSQL-backed TypeScript event sourcing for NPC memory, conflicting testimony,
neural manipulation, personal beliefs and deterministic natural dialogue.
No LLM or simulated database transactions.

## Prerequisites

- Node.js 20 LTS, at least 20.19 (verified on 20.20.2), npm, optionally nvm.
- Docker Engine and Docker Compose; PostgreSQL 16 image access.
- Available localhost port 54329.

## Install and run

From the repository root:

1. Install/select Node and dependencies:

   ```sh
   nvm install
   nvm use
   npm ci
   ```

   Without nvm, install Node 20.19+ directly first.

2. Configure the development connection and generate Prisma:

   ```sh
   cp .env.example .env
   npx prisma generate
   ```

3. Start PostgreSQL and deploy committed migrations:

   ```sh
   docker compose up -d --wait
   npm run db:migrate
   ```

   `npm run db:up` is the Compose startup shortcut.

4. Check formatting, types and real PostgreSQL tests:

   ```sh
   npm run lint
   npm run typecheck
   npm test
   ```

   `npm run format` applies Prettier. Lint checks formatting; TypeScript strict
   mode supplies the semantic/static type check.

5. Execute Daniel's narrative:

   ```sh
   npm run scenario
   ```

   Faction A accuses the player, Faction B denies it, Daniel sees exonerating
   evidence, the player hacks that recollection, and Daniel is interrogated.
   Output includes his natural answer, objective truth, current/untampered stances,
   and forensic provenance. Each run uses a fresh Daniel identity.

Fresh-database verification:

```sh
docker compose down -v
docker compose up -d --wait
npm run typecheck
npm test
npm run scenario
```

**Tests destroy data:** they TRUNCATE events, streams, npc_state and world_state.
Never use shared or production data. Global setup runs prisma migrate deploy.
Files run serially; concurrency tests use independent interactive transactions
with Promise.all/Promise.allSettled.

The example credentials are development-only. PostgreSQL binds to localhost.
If Docker Hub rate-limits the pull:

```sh
docker pull mirror.gcr.io/library/postgres:16
docker tag mirror.gcr.io/library/postgres:16 postgres:16
npm run db:up
```

## Architecture

| Module                    | Responsibility                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| src/events/schema.ts      | Zod event union and validated persisted-event reads                                              |
| src/events/event-store.ts | Transaction boundary, append/OCC/idempotency, atomic projection persistence, replay entry points |
| src/events/processor.ts   | Pure reducers, derived belief transitions, world reduction and global replay                     |
| src/npc/memory.ts         | Five memory kinds, versions/provenance, accessible memory selectors                              |
| src/npc/belief-engine.ts  | Weighted log odds, contradictions, entropy and forensic resolution                               |
| src/npc/interrogation.ts  | Natural confidence/evidence dialogue, deterministic variants, versioned citations                |
| src/shared/canonical.ts   | Canonical JSON                                                                                   |
| src/scenario/             | Reusable narrative and executable CLI                                                            |
| src/database.ts           | PostgreSQL Prisma adapter                                                                        |
| prisma/schema.prisma      | Events, streams, NPC/world projections                                                           |
| prisma/migrations/        | Committed SQL constraints and immutable-event trigger                                            |
| tests/                    | Pure unit tests and real PostgreSQL integration tests                                            |

The original domain/store/scenario-data paths are compatibility exports only.

## Memory and epistemic boundaries

All five memory kinds are materialized:

- **objective:** WorldEventOccurred creates an objective memory in world_state
  with its source event reference. Full victim/perpetrator/location details remain
  in the immutable event. World memories never automatically enter an NPC;
  witnessing requires an explicit ObservationRecorded.
- **observation:** Direct evidence, reliability 0.95.
- **testimony:** Faction claims, weighted by NPC source trust (default 0.65).
- **belief:** BeliefStateTransitioned appends a personal belief-memory version in
  npc_state.beliefMemories, retaining stance, probability, entropy and evidence
  provenance. These memories never enter evidence aggregation.
- **external_modification:** MemoryModified appends a linked version n+1. Original
  claims and hack actor/method remain forensic history. Accessible recollections
  preserve their apparent source/kind; Daniel cannot see that they were hacked.

`accessible(state)` returns current evidence recollections without forensic
metadata. `accessibleMemories(state)` additionally includes current personal
beliefs. Neither includes objective truth. Full histories are system-side data.

## Belief resolution and dialogue

Claims are subject/predicate/object tuples plus polarity. The resolver sorts
evidence and sums signed log odds. Reliability is bounded to [0.01,0.99]; source
trust below 0.5 reverses a contribution. Probabilities round to eight decimals.
Probability >=0.7 means believes_true, <=0.3 means believes_false, otherwise
uncertain. Every belief includes supporting/contradicting IDs **and versions**,
a contradiction flag and binary entropy uncertainty in [0,1].

`resolveForensicBeliefs(state)` resolves from original evidence versions, giving
later neural writes zero weight, and returns the manipulation/provenance trail.
It uses current source trust: this is an **untampered-memory counterfactual**,
not an omniscient truth detector. Daniel's current murder belief is true while
his untampered-memory belief is false. Forensic results never enter dialogue.

Dialogue context contains interrogatorId, optional seed, and a structured
`propositionKey(claim)` question. This is not a free-text question parser.
Unknown questions yield an honest lack-of-memory answer.

Dialogue states the proposition in words, hedges by confidence band, names the
strongest supporting recollection by perceived kind ("I saw it myself" or
"Faction A told me"), and acknowledges opposing testimony/evidence.
SHA-256 of canonical relevant belief, accessible evidence and context selects a
template. World truth, forensic history, personal belief-memory histories,
unrelated propositions, time and randomness cannot affect wording.

The pure function returns:

```ts
{
  answer: string;
  stance: 'believes_true' | 'believes_false' | 'uncertain';
  probability: number;
  citedMemories: {
    id: string;
    version: number;
  }
  [];
  acknowledgedContradictions: {
    id: string;
    version: number;
  }
  [];
}
```

The processor persists this in InterrogationConducted.resolution, alongside
legacy answer/citedMemoryIds fields. Caller-provided output is ignored.

## Guarantees and enforcement

| Guarantee                     | Enforcement                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immutable events              | UUID primary key and SQL UPDATE/DELETE rejection trigger                                                                                           |
| No silent overwrite           | Transactional stream upsert, conditional version lock/CAS, unique aggregate/version, typed ConcurrencyError with expected/actual                   |
| Safe retry                    | Concurrency loser reloads version and retries its original command/key; integration tested                                                         |
| Duplicate protection          | Transaction-scoped advisory key lock plus unique idempotency key; returns stored events without reprocessing                                       |
| Key reuse safety              | Existing key must match aggregate/payload; interrogation compares request context because output is processor-owned                                |
| Atomic log/projections        | Primary/derived inserts, stream version and NPC/world writes commit or roll back together                                                          |
| Original memories recoverable | Hacks append linked versions instead of overwriting                                                                                                |
| No belief feedback            | Evidence selectors exclude belief memories                                                                                                         |
| Deterministic replay          | Pure validated-event folds using recorded IDs, no clocks/randomness in reducers                                                                    |
| Whole-system reconstruction   | rebuildAll reads one global_position-ordered log snapshot, checks contiguous stream versions, reproduces NPC/world projections and stream versions |
| Stable natural dialogue       | Canonical relevant-state/context hash and stable evidence ranking; byte equality tested after replay                                               |

Commands may append derived transitions: advance expectedVersion to the **last
returned event version**, not command count. Keys containing reserved
`:derived:` are rejected. Clock and ID factories are injected at the store boundary.

`rebuildFromLog(npcId)` and `rebuildAll()` return snapshots without overwriting live
projections, preventing rebuilds from clobbering concurrent writes. Upgrades from
the initial core should deploy the world migration and apply reconstructed state
under application-controlled maintenance before writing old-format projections;
automatic live projection replacement is deliberately not exposed.

## Operational boundaries

This is a core library/CLI, not an authenticated public API. Production callers
must authorize actors/hacks, isolate database access, protect DATABASE_URL and
use a DB role without TRUNCATE, DDL or trigger-disable privileges.
Backup, encryption, retention and connection pool policy belong to deployment.

The lockfile pins dependencies; the effect patch override addresses the Prisma
config advisory. Prisma's unused local-stream development tool declares Node >=22
and npm emits EBADENGINE on Node 20. The loaded environment is Node 20.20.2;
generator, migrations, typecheck, tests and scenario execute there. Prisma itself
supports Node >=20.19. This is an upstream transitive-tool warning.

TEST_REPORT.md contains real, unedited terminal output from fresh-database
typecheck, tests and scenario execution.
