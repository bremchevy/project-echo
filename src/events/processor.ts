import type { Event } from '@prisma/client';
import { canonical } from '../shared/canonical.js';
import { propositionKey, resolveBeliefs } from '../npc/belief-engine.js';
import {
  accessible,
  emptyState,
  type Memory,
  type State,
  type World,
} from '../npc/memory.js';
import { interrogate } from '../npc/interrogation.js';
import { readEvent, type DomainEvent } from './schema.js';

export interface PendingEvent {
  id: string;
  event: DomainEvent;
}
export interface Projection<T> {
  state: T;
  version: number;
}
export interface RebuiltProjections {
  npcs: Record<string, Projection<State>>;
  world: Record<string, Projection<World>>;
  streams: Record<string, { aggregateType: string; version: number }>;
}

/** Fold one recorded event into an NPC projection without side effects. */
export function reduce(
  state: State,
  event: DomainEvent,
  eventId: string,
): State {
  const nextState = structuredClone(state);
  if (
    event.type === 'ObservationRecorded' ||
    event.type === 'TestimonyReceived'
  ) {
    if (nextState.memories[event.memoryId])
      throw new Error('Memory already exists');
    const observation = event.type === 'ObservationRecorded';
    const source = observation ? event.source : event.factionId;
    nextState.memories[event.memoryId] = [
      {
        id: event.memoryId,
        versionId: eventId,
        version: 1,
        kind: observation ? 'observation' : 'testimony',
        perceivedKind: observation ? 'observation' : 'testimony',
        claim: event.claim,
        source,
        provenance: [{ eventId, actor: source }],
      },
    ];
  } else if (event.type === 'MemoryModified') {
    const history = nextState.memories[event.memoryId];
    if (!history) throw new Error('Unknown memory');
    const previous = history[history.length - 1];
    history.push({
      ...previous,
      versionId: eventId,
      previousVersionId: previous.versionId,
      version: previous.version + 1,
      kind: 'external_modification',
      claim: event.claim,
      provenance: [
        ...previous.provenance,
        { eventId, actor: event.actor, method: event.method },
      ],
    });
  } else if (event.type === 'FactionInteraction') {
    Object.defineProperty(nextState.trust, event.factionId, {
      value: event.reliability,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else if (event.type === 'InterrogationConducted') {
    nextState.interrogations.push(event);
  } else if (event.type === 'BeliefStateTransitioned') {
    const evidence = accessible(nextState).find(
      (memory) => propositionKey(memory.claim) === event.proposition,
    );
    if (!evidence) throw new Error('Belief transition has no evidence');
    const memoryId = 'belief:' + event.proposition;
    const history = nextState.beliefMemories[memoryId] ?? [];
    const previous = history.at(-1);
    const provenance = event.evidenceIds.flatMap((id) => {
      const memory = nextState.memories[id]?.at(-1);
      return memory
        ? [{ eventId: memory.versionId, actor: memory.source }]
        : [];
    });
    const memory: Memory = {
      id: memoryId,
      versionId: eventId,
      version: history.length + 1,
      ...(previous ? { previousVersionId: previous.versionId } : {}),
      kind: 'belief',
      perceivedKind: 'belief',
      source: 'personal-belief',
      belief: structuredClone(nextState.beliefs[event.proposition]),
      claim: { ...evidence.claim, polarity: event.probability >= 0.5 },
      provenance: [...provenance, { eventId, actor: 'belief-processor' }],
    };
    nextState.beliefMemories[memoryId] = [...history, memory];
  }
  nextState.beliefs = resolveBeliefs(accessible(nextState), nextState.trust);
  return nextState;
}

/** Prepare a command and all derived transitions using caller-supplied event IDs. */
export function processNpcCommand(
  state: State,
  event: DomainEvent,
  nextId: () => string,
) {
  let processedEvent = event;
  if (event.type === 'InterrogationConducted') {
    const resolution = interrogate(state, event.context);
    processedEvent = {
      ...event,
      question: event.context.question,
      answer: resolution.answer,
      citedMemoryIds: resolution.citedMemories.map((memory) => memory.id),
      resolution,
    };
  }
  const primaryId = nextId();
  const pending: PendingEvent[] = [{ id: primaryId, event: processedEvent }];
  let nextState = reduce(state, processedEvent, primaryId);
  for (const [proposition, belief] of Object.entries(nextState.beliefs)) {
    if (canonical(state.beliefs[proposition] ?? null) === canonical(belief))
      continue;
    const transition: DomainEvent = {
      type: 'BeliefStateTransitioned',
      proposition,
      oldStance: state.beliefs[proposition]?.stance ?? 'uncertain',
      newStance: belief.stance,
      probability: belief.probability,
      evidenceIds: [...belief.supporting, ...belief.contradicting].map(
        (memory) => memory.id,
      ),
    };
    const transitionId = nextId();
    pending.push({ id: transitionId, event: transition });
    nextState = reduce(nextState, transition, transitionId);
  }
  return { state: nextState, pending };
}

/** Record objective world facts without placing them in any NPC's memory. */
export function reduceWorld(
  world: World,
  event: DomainEvent,
  eventId: string,
): World {
  if (event.type !== 'WorldEventOccurred')
    throw new Error('World projection requires objective event');
  return {
    memories: {
      ...world.memories,
      [eventId]: [
        {
          id: eventId,
          versionId: eventId,
          version: 1,
          kind: 'objective',
          perceivedKind: 'objective',
          claim: event.claim,
          source: 'world',
          provenance: [{ eventId, actor: 'world' }],
        },
      ],
    },
  };
}

/** Replay recorded rows in global-position order, regenerating no events or IDs. */
export function replayAll(rows: Event[]): RebuiltProjections {
  const projections: RebuiltProjections = { npcs: {}, world: {}, streams: {} };
  for (const row of [...rows].sort((left, right) =>
    left.globalPosition < right.globalPosition
      ? -1
      : left.globalPosition > right.globalPosition
        ? 1
        : 0,
  )) {
    const event = readEvent(row);
    const previousVersion = projections.streams[row.aggregateId]?.version ?? 0;
    if (row.version !== previousVersion + 1)
      throw new Error('Non-contiguous stream: ' + row.aggregateId);
    projections.streams[row.aggregateId] = {
      aggregateType: row.aggregateType,
      version: row.version,
    };
    if (row.aggregateType === 'npc') {
      const npcId = row.aggregateId.slice(4);
      const previous = projections.npcs[npcId]?.state ?? emptyState();
      projections.npcs[npcId] = {
        state: reduce(previous, event, row.id),
        version: row.version,
      };
    } else if (row.aggregateType === 'world') {
      const previous = projections.world[row.aggregateId]?.state ?? {
        memories: {},
      };
      projections.world[row.aggregateId] = {
        state: reduceWorld(previous, event, row.id),
        version: row.version,
      };
    }
  }
  return projections;
}
