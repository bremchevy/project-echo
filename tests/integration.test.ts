import { createDatabase } from '../src/database.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accessible,
  accessibleMemories,
  interrogate,
  propositionKey,
  resolveForensicBeliefs,
  resolveBeliefs,
} from '../src/domain.js';
import {
  ConcurrencyError,
  EventStore,
  readEvent,
  type Command,
} from '../src/store.js';
import { murder, runScenario } from '../src/scenario-data.js';
import { replayAll } from '../src/events/processor.js';
const database = createDatabase();
const store = new EventStore(database, () => new Date('2026-01-01T00:00:00Z'));
beforeEach(async () => {
  await database.$executeRawUnsafe(
    'TRUNCATE events, streams, npc_state, world_state RESTART IDENTITY',
  );
});
afterAll(async () => {
  await database.$disconnect();
});
const command = (): Command => ({
  aggregateId: 'npc:Daniel',
  expectedVersion: 0,
  idempotencyKey: randomUUID(),
  event: {
    type: 'TestimonyReceived',
    memoryId: randomUUID(),
    claim: murder,
    factionId: 'A',
  },
  metadata: { actor: 'A' },
});
describe('Daniel integration', () => {
  it('deduplicates interrogation retries with an explicitly undefined optional seed', async () => {
    const initial = await store.append(command());
    const context = {
      interrogatorId: 'detective',
      question: propositionKey(murder),
      seed: undefined,
    };
    const event = {
      type: 'InterrogationConducted' as const,
      context,
      question: context.question,
      answer: '',
      citedMemoryIds: [],
    };
    const interrogation = {
      ...command(),
      expectedVersion: initial.events.at(-1)!.version,
      event,
    };
    const first = await store.append(interrogation);
    const state = await store.state('Daniel');
    const eventCount = await database.event.count();
    const retry = await store.append(interrogation);
    expect(retry.duplicate).toBe(true);
    expect(retry.events).toEqual(first.events);
    const absentSeedRetry = await store.append({
      ...interrogation,
      event: {
        ...event,
        context: {
          interrogatorId: context.interrogatorId,
          question: context.question,
        },
      },
    });
    expect(absentSeedRetry.duplicate).toBe(true);
    expect(absentSeedRetry.events).toEqual(first.events);
    expect(await store.state('Daniel')).toEqual(state);
    expect(await database.event.count()).toBe(eventCount);
    await expect(
      store.append({
        ...interrogation,
        event: { ...event, context: { ...context, seed: 'different' } },
      }),
    ).rejects.toThrow('Idempotency key reused');
  });
  it('retires unsupported personal beliefs from access without deleting their history', async () => {
    const memoryId = randomUUID();
    const initial = await store.append({
      ...command(),
      event: {
        type: 'ObservationRecorded',
        memoryId,
        claim: murder,
        source: 'eyes',
      },
    });
    const originalState = await store.state('Daniel');
    const originalBeliefId = 'belief:' + propositionKey(murder);
    const changedClaim = { ...murder, object: 'another-victim' };
    const changed = await store.append({
      ...command(),
      expectedVersion: initial.events.at(-1)!.version,
      event: {
        type: 'MemoryModified',
        memoryId,
        claim: changedClaim,
        actor: 'player',
        method: 'hack',
      },
    });
    const changedState = await store.state('Daniel');
    expect(changedState.beliefs).not.toHaveProperty(propositionKey(murder));
    expect(changedState.beliefMemories[originalBeliefId]).toEqual(
      originalState.beliefMemories[originalBeliefId],
    );
    expect(
      accessibleMemories(changedState)
        .filter((memory) => memory.perceivedKind === 'belief')
        .map((memory) => propositionKey(memory.claim)),
    ).toEqual([propositionKey(changedClaim)]);
    expect(await store.rebuildFromLog('Daniel')).toEqual(changedState);

    await store.append({
      ...command(),
      expectedVersion: changed.events.at(-1)!.version,
      event: {
        type: 'MemoryModified',
        memoryId,
        claim: murder,
        actor: 'player',
        method: 'hack',
      },
    });
    const restoredState = await store.state('Daniel');
    expect(restoredState.beliefMemories[originalBeliefId]).toHaveLength(2);
    expect(
      accessibleMemories(restoredState)
        .filter((memory) => memory.perceivedKind === 'belief')
        .map((memory) => ({ id: memory.id, version: memory.version })),
    ).toEqual([{ id: originalBeliefId, version: 2 }]);
    expect(await store.rebuildFromLog('Daniel')).toEqual(restoredState);
  });
  it('answers from hacked beliefs rather than objective truth', async () => {
    const scenario = await runScenario(store);
    expect(scenario.beforeHack.beliefs[propositionKey(murder)].stance).toBe(
      'believes_false',
    );
    expect(scenario.answer.stance).toBe('believes_true');
    expect(scenario.state.interrogations[0].answer).toContain(
      'the player committed the murder',
    );
    expect(scenario.state.interrogations[0].answer).not.toContain('assassin');
    expect(accessible(scenario.state)).toHaveLength(3);
    expect(
      (
        await database.event.findFirstOrThrow({
          where: { eventType: 'WorldEventOccurred' },
        })
      ).payload,
    ).toMatchObject({ actualPerpetrator: 'assassin' });
  });
  it('retains every original event and its supplied timestamp', async () => {
    await runScenario(store);
    const rows = await database.event.findMany();
    expect(
      rows.map(readEvent).filter((e) => e.type === 'TestimonyReceived'),
    ).toHaveLength(2);
    expect(
      rows.map(readEvent).filter((e) => e.type === 'ObservationRecorded'),
    ).toHaveLength(1);
    expect(
      rows.every(
        (scenario) =>
          scenario.occurredAt.toISOString() === '2026-01-01T00:00:00.000Z',
      ),
    ).toBe(true);
  });
  it('creates a new linked memory version and hides hack provenance in accessible view', async () => {
    const scenario = await runScenario(store),
      history = scenario.state.memories[scenario.observation];
    expect(history).toHaveLength(2);
    expect(history[0].claim.polarity).toBe(false);
    expect(history[1]).toMatchObject({
      version: 2,
      previousVersionId: history[0].versionId,
      kind: 'external_modification',
    });
    expect(history[1].provenance.at(-1)).toMatchObject({
      actor: 'player',
      method: 'neural-write',
    });
    expect(
      accessible(scenario.state).find((m) => m.id === scenario.observation),
    ).not.toHaveProperty('provenance');
  });
  it('keeps conflicting evidence traceable', async () => {
    const scenario = await runScenario(store),
      belief = scenario.state.beliefs[propositionKey(murder)];
    expect(belief.contradiction).toBe(true);
    expect(belief.supporting).toContainEqual({
      id: scenario.observation,
      version: 2,
    });
    expect(belief.contradicting).toContainEqual({
      id: scenario.factionBMemoryId,
      version: 1,
    });
  });
  it('replays to exactly the transactional projection', async () => {
    const scenario = await runScenario(store);
    expect(await store.rebuildFromLog('Daniel')).toEqual(scenario.state);
  });
  it('does not execute duplicate events or projections twice', async () => {
    const pendingCommand = command(),
      first = await store.append(pendingCommand),
      state = await store.state('Daniel');
    const duplicate = await store.append(pendingCommand);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.events).toEqual(first.events);
    expect(await store.state('Daniel')).toEqual(state);
    expect(await database.event.count()).toBe(first.events.length);
  });
  it('allows exactly one concurrent expected-version update without loss', async () => {
    const results = await Promise.allSettled([
      store.append(command()),
      store.append(command()),
    ]);
    expect(
      results.filter((scenario) => scenario.status === 'fulfilled'),
    ).toHaveLength(1);
    const failure = results.find(
      (scenario) => scenario.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(ConcurrencyError);
    expect(failure.reason.expected).toBe(0);
    expect(failure.reason.actual).toBe(2);
    expect(await database.event.count()).toBe(2);
    expect(await store.rebuildFromLog('Daniel')).toEqual(
      await store.state('Daniel'),
    );
  });
  it('does not confuse later causally linked commands with derived events on retry', async () => {
    const pendingCommand = command(),
      first = await store.append(pendingCommand);
    await store.append({
      ...command(),
      expectedVersion: 2,
      metadata: { actor: 'A', causation: first.events[0].id },
    });
    expect((await store.append(pendingCommand)).events).toEqual(first.events);
  });
  it('serializes concurrent duplicate submissions to one primary event', async () => {
    const pendingCommand: Command = {
      ...command(),
      event: { type: 'FactionInteraction', factionId: 'A', reliability: 0.7 },
    };
    const results = await Promise.all([
      store.append(pendingCommand),
      store.append(pendingCommand),
    ]);
    expect(results.map((scenario) => scenario.duplicate).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      await database.event.count({
        where: { idempotencyKey: pendingCommand.idempotencyKey },
      }),
    ).toBe(1);
    expect(await database.event.count()).toBe(1);
  });
  it('rejects UPDATE and DELETE at database level', async () => {
    await store.append(command());
    await expect(
      database.$executeRawUnsafe("UPDATE events SET event_type='changed'"),
    ).rejects.toThrow('append-only');
    await expect(
      database.$executeRawUnsafe('DELETE FROM events'),
    ).rejects.toThrow('append-only');
  });
  it('returns deterministic interrogation for identical state and context', async () => {
    const scenario = await runScenario(store);
    expect(interrogate(scenario.state, scenario.context)).toEqual(
      interrogate(structuredClone(scenario.state), { ...scenario.context }),
    );
  });
  it('rolls back the stream, events and projection on invalid memory modification', async () => {
    const pendingCommand = command();
    await expect(
      store.append({
        ...pendingCommand,
        event: {
          type: 'MemoryModified',
          memoryId: randomUUID(),
          claim: murder,
          actor: 'player',
          method: 'hack',
        },
      }),
    ).rejects.toThrow('Unknown memory');
    expect(await database.event.count()).toBe(0);
    expect(await database.stream.count()).toBe(0);
    expect(await database.npcState.count()).toBe(0);
  });
  it('validates events on append and read, rejecting key reuse', async () => {
    const pendingCommand = command();
    await expect(
      store.append({ ...pendingCommand, event: { type: 'Invalid' } as never }),
    ).rejects.toThrow();
    const result = await store.append(pendingCommand);
    expect(() =>
      readEvent({ ...result.events[0], payload: { type: 'Invalid' } }),
    ).toThrow();
    await expect(
      store.append({
        ...pendingCommand,
        event: { type: 'FactionInteraction', factionId: 'A', reliability: 0.5 },
      }),
    ).rejects.toThrow('Idempotency key reused');
  });
  it('replays an empty log and keeps projection version equal to its stream', async () => {
    expect(await store.rebuildAll()).toEqual({
      npcs: {},
      world: {},
      streams: {},
    });
    expect(await store.rebuildFromLog('missing')).toEqual(
      await store.state('missing'),
    );
    const scenario = await runScenario(store);
    expect(
      (
        await database.npcState.findUniqueOrThrow({
          where: { npcId: 'Daniel' },
        })
      ).version,
    ).toBe(scenario.version);
    expect(
      (
        await database.stream.findUniqueOrThrow({
          where: { aggregateId: 'npc:Daniel' },
        })
      ).version,
    ).toBe(scenario.version);
  });
  it('produces natural, cited, contradiction-aware dialogue identical after replay', async () => {
    const scenario = await runScenario(store);
    const answer = interrogate(scenario.state, scenario.context);
    expect(answer.answer).toContain('the player committed the murder');
    expect(answer.answer).toContain('I saw it myself');
    expect(answer.answer).toContain(
      'Faction B told me the player did not commit the murder',
    );
    expect(answer.answer).not.toMatch(/assassin|hack|neural|believes_true/);
    expect(answer.probability).toBe(0.95);
    expect(answer.citedMemories).toContainEqual({
      id: scenario.observation,
      version: 2,
    });
    expect(answer.acknowledgedContradictions).toContainEqual({
      id: scenario.factionBMemoryId,
      version: 1,
    });
    expect(interrogate(scenario.state, scenario.context).answer).toBe(
      answer.answer,
    );
    expect(
      interrogate(await store.rebuildFromLog('Daniel'), scenario.context),
    ).toEqual(answer);
    expect(scenario.state.interrogations.at(-1)?.resolution).toEqual(answer);
  });
  it('persists all five memory kinds without self-reinforcing personal beliefs', async () => {
    const scenario = await runScenario(store);
    const world = await store.worldState();
    const npcMemories = Object.values(scenario.state.memories).flat();
    expect(new Set(npcMemories.map((memory) => memory.kind))).toEqual(
      new Set(['observation', 'testimony', 'external_modification']),
    );
    expect(
      Object.values(world.memories)
        .flat()
        .map((memory) => memory.kind),
    ).toEqual(['objective']);
    const personalBeliefs = Object.values(scenario.state.beliefMemories).flat();
    expect(personalBeliefs.length).toBeGreaterThan(1);
    expect(personalBeliefs.every((memory) => memory.kind === 'belief')).toBe(
      true,
    );
    expect(personalBeliefs.at(-1)?.belief?.stance).toBe('believes_true');
    expect(
      accessibleMemories(scenario.state).some(
        (memory) => memory.perceivedKind === 'belief',
      ),
    ).toBe(true);
    expect(
      accessibleMemories(scenario.state).some(
        (memory) => memory.perceivedKind === 'objective',
      ),
    ).toBe(false);
    expect(
      resolveBeliefs(accessible(scenario.state), scenario.state.trust),
    ).toEqual(scenario.state.beliefs);
    const originalBelief = structuredClone(scenario.state.beliefs);
    scenario.state.beliefMemories = {};
    expect(
      resolveBeliefs(accessible(scenario.state), scenario.state.trust),
    ).toEqual(originalBelief);
  });
  it('resolves untampered forensic beliefs and traces the hack to its original version', async () => {
    const scenario = await runScenario(store);
    const forensic = resolveForensicBeliefs(scenario.state);
    expect(scenario.state.beliefs[propositionKey(murder)].stance).toBe(
      'believes_true',
    );
    expect(forensic.beliefs[propositionKey(murder)].stance).toBe(
      'believes_false',
    );
    expect(
      forensic.beliefs[propositionKey(murder)].contradicting,
    ).toContainEqual({ id: scenario.observation, version: 1 });
    expect(forensic.manipulations).toHaveLength(1);
    expect(forensic.manipulations[0]).toMatchObject({
      id: scenario.observation,
      version: 2,
      previousVersionId:
        scenario.state.memories[scenario.observation][0].versionId,
    });
    expect(forensic.manipulations[0].provenance.at(-1)).toMatchObject({
      actor: 'player',
      method: 'neural-write',
    });
  });
  it('lets the concurrency loser reload and retry without losing either command', async () => {
    const commands = [command(), command()];
    const results = await Promise.allSettled(
      commands.map((pending) => store.append(pending)),
    );
    const failedIndex = results.findIndex(
      (result) => result.status === 'rejected',
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failure = results[failedIndex] as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(ConcurrencyError);
    const current = await database.stream.findUniqueOrThrow({
      where: { aggregateId: 'npc:Daniel' },
    });
    await store.append({
      ...commands[failedIndex],
      expectedVersion: current.version,
    });
    expect(
      await database.event.count({ where: { eventType: 'TestimonyReceived' } }),
    ).toBe(2);
    expect(accessible(await store.state('Daniel'))).toHaveLength(2);
    expect(await store.rebuildFromLog('Daniel')).toEqual(
      await store.state('Daniel'),
    );
  });
  it('rebuilds every NPC, world, and stream projection from the global log', async () => {
    await runScenario(store);
    await runScenario(store, 'Maya');
    await store.append({
      ...command(),
      aggregateId: 'faction:A',
      event: { type: 'FactionInteraction', factionId: 'A', reliability: 0.9 },
    });
    const rebuilt = await store.rebuildAll();
    const reverseOrderedLog = await database.event.findMany({
      orderBy: { globalPosition: 'desc' },
    });
    expect(replayAll(reverseOrderedLog)).toEqual(rebuilt);
    for (const projection of await database.npcState.findMany()) {
      expect(rebuilt.npcs[projection.npcId]).toEqual({
        state: projection.state,
        version: projection.version,
      });
    }
    for (const projection of await database.worldState.findMany()) {
      expect(rebuilt.world[projection.worldId]).toEqual({
        state: projection.state,
        version: projection.version,
      });
    }
    for (const stream of await database.stream.findMany()) {
      expect(rebuilt.streams[stream.aggregateId]).toEqual({
        aggregateType: stream.aggregateType,
        version: stream.version,
      });
    }
    expect(Object.keys(rebuilt.npcs)).toHaveLength(2);
    expect(Object.keys(rebuilt.world)).toHaveLength(1);
  });
  it('rejects a replay log with a missing stream version', async () => {
    const appended = await store.append(command());
    const corrupted = appended.events.map((event) => ({
      ...event,
      version: event.version + 1,
    }));
    expect(() => replayAll(corrupted)).toThrow('Non-contiguous stream');
  });
});
