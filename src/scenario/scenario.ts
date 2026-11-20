import { randomUUID } from 'node:crypto';
import { EventStore } from '../events/event-store.js';
import { type DomainEvent } from '../events/schema.js';
import { interrogate } from '../npc/interrogation.js';
import { propositionKey } from '../npc/belief-engine.js';

export const murder = {
  subject: 'player',
  predicate: 'murdered',
  object: 'victim',
  polarity: true,
};
/** Persist Daniel's conflicting evidence, neural hack, and interrogation. */
export async function runScenario(store: EventStore, npcId = 'Daniel') {
  const aggregateId = 'npc:' + npcId;
  let version = 0;
  const submit = async (event: DomainEvent) => {
    const result = await store.append({
      aggregateId,
      expectedVersion: version,
      idempotencyKey: randomUUID(),
      event,
      metadata: { actor: 'scenario' },
    });
    version = result.events.at(-1)!.version;
    return result;
  };
  await store.append({
    aggregateId: 'world',
    expectedVersion:
      (await store.db.stream.findUnique({ where: { aggregateId: 'world' } }))
        ?.version ?? 0,
    idempotencyKey: randomUUID(),
    metadata: { actor: 'world' },
    event: {
      type: 'WorldEventOccurred',
      claim: { ...murder, polarity: false },
      victim: 'victim',
      actualPerpetrator: 'assassin',
      location: 'dock',
    },
  });
  await submit({
    type: 'FactionInteraction',
    factionId: 'A',
    reliability: 0.8,
  });
  await submit({
    type: 'FactionInteraction',
    factionId: 'B',
    reliability: 0.8,
  });
  const factionAMemoryId = randomUUID();
  const factionBMemoryId = randomUUID();
  const observation = randomUUID();
  await submit({
    type: 'TestimonyReceived',
    memoryId: factionAMemoryId,
    claim: murder,
    factionId: 'A',
  });
  await submit({
    type: 'TestimonyReceived',
    memoryId: factionBMemoryId,
    claim: { ...murder, polarity: false },
    factionId: 'B',
  });
  await submit({
    type: 'ObservationRecorded',
    memoryId: observation,
    claim: { ...murder, polarity: false },
    source: 'physical-evidence',
  });
  const beforeHack = await store.state(npcId);
  await submit({
    type: 'MemoryModified',
    memoryId: observation,
    claim: murder,
    actor: 'player',
    method: 'neural-write',
  });
  const context = {
    interrogatorId: 'detective',
    question: propositionKey(murder),
    seed: 'echo',
  };
  await submit({
    type: 'InterrogationConducted',
    context,
    question: context.question,
    answer: '',
    citedMemoryIds: [],
  });
  const state = await store.state(npcId);
  return {
    state,
    beforeHack,
    answer: interrogate(state, context),
    context,
    observation,
    factionAMemoryId,
    factionBMemoryId,
    version,
    npcId,
  };
}
