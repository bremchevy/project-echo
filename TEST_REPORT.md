# Verification report

Environment: Node v20.20.2, PostgreSQL 16 in Docker, Prisma 7.10.1, Vitest 4.1.12.

The database volume was removed with `docker compose down -v` and recreated with `docker compose up -d --wait` immediately before this verification. Global setup applied both committed migrations. All four commands below exited with status 0; no tests failed in this rework verification.

Every terminal block is copied verbatim, including whitespace, from its captured stdout/stderr. TEST_REPORT.md is excluded from Prettier to preserve that output.

## npm run typecheck

```text

> project-echo@1.0.0 typecheck
> tsc --noEmit

```

## npm test

```text

> project-echo@1.0.0 test
> vitest run


 RUN  v4.1.12 /home/ubuntu/repos/project-echo

Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Datasource "db": PostgreSQL database "echo", schema "public" at "localhost:54329"

2 migrations found in prisma/migrations

Applying migration `202611190001_init`
Applying migration `202611200001_world_projection`

The following migration(s) have been applied:

migrations/
  └─ 202611190001_init/
    └─ migration.sql
  └─ 202611200001_world_projection/
    └─ migration.sql

All migrations have been successfully applied.

 Test Files  2 passed (2)
      Tests  31 passed (31)
   Start at  01:07:38
   Duration  3.38s (transform 86ms, setup 0ms, import 269ms, tests 1.64s, environment 0ms)

```

## npm run scenario

```text

> project-echo@1.0.0 scenario
> tsx src/scenario/index.ts

Faction A accuses the player. Faction B denies it. Daniel sees exonerating evidence.
The player hacks that observation into an incriminating recollection.
Daniel: I'm convinced the player committed the murder. I saw it myself. Still, Faction B told me the player did not commit the murder, so I know the accounts don't all agree.
Objective truth: the assassin committed the murder; the player is innocent.
Daniel current stance: believes_true
Untampered memory stance: believes_false
Forensic manipulation trail: [
  {
    "id": "294c2176-1309-43b7-9ee5-8e6e61cd04b8",
    "version": 2,
    "previousVersionId": "97a2fa71-de38-4421-aee1-ba40eb1c39ec",
    "provenance": [
      {
        "actor": "physical-evidence",
        "eventId": "97a2fa71-de38-4421-aee1-ba40eb1c39ec"
      },
      {
        "actor": "player",
        "method": "neural-write",
        "eventId": "54f26d6e-b30e-44df-8d68-20ed95559ce4"
      }
    ]
  }
]
```

## npm run lint

```text

> project-echo@1.0.0 lint
> prettier --check .

Checking formatting...
All matched files use Prettier code style!
```

## Coverage notes

The 21 original tests remain, with obsolete dialogue-string and citation-field expectations updated to the requested natural/structured output. Ten new tests cover natural dialogue and replay byte equality, all five materialized memory kinds, non-self-reinforcing personal beliefs, original-version forensic resolution/provenance, entropy, invalid reliability, empty forensic results, source/confidence wording, concurrency reload/retry, whole-log projection replay, and invalid replay ordering/gaps. Empty whole-log replay is also asserted. The global replay test compares all NPC/world projection rows and all stream versions, and additionally replays reverse-ordered input to verify global-position ordering.

The existing documented upstream `@prisma/streams-local` Node >=22 engine warning appears during dependency installation under the required Node 20 environment; the tool is unused by this project. All commands above executed on Node 20.20.2.
