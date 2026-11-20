import type { Claim, DomainEvent } from '../events/schema.js';
import { propositionKey, type Belief } from './belief-engine.js';

export type MemoryKind =
  | 'objective'
  | 'observation'
  | 'testimony'
  | 'belief'
  | 'external_modification';
export interface MemoryReference {
  id: string;
  version: number;
}
export interface Provenance {
  eventId: string;
  actor: string;
  method?: string;
}
export interface Memory extends MemoryReference {
  versionId: string;
  previousVersionId?: string;
  kind: MemoryKind;
  claim: Claim;
  source: string;
  perceivedKind: Exclude<MemoryKind, 'external_modification'>;
  provenance: Provenance[];
  belief?: Belief;
}
export interface EvidenceMemory extends MemoryReference {
  claim: Claim;
  source: string;
  perceivedKind: 'observation' | 'testimony';
}
export interface State {
  memories: Record<string, Memory[]>;
  beliefMemories: Record<string, Memory[]>;
  trust: Record<string, number>;
  beliefs: Record<string, Belief>;
  interrogations: Extract<DomainEvent, { type: 'InterrogationConducted' }>[];
}
export interface World {
  memories: Record<string, Memory[]>;
}

/** Create an isolated NPC projection with no knowledge of world truth. */
export function emptyState(): State {
  return {
    memories: {},
    beliefMemories: {},
    trust: {},
    beliefs: {},
    interrogations: [],
  };
}

/** Return the latest evidence recollections without forensic manipulation metadata. */
export function accessible(state: State): EvidenceMemory[] {
  return Object.values(state.memories)
    .map((history) => history[history.length - 1])
    .filter(
      (memory) =>
        memory.perceivedKind === 'observation' ||
        memory.perceivedKind === 'testimony',
    )
    .map((memory) => ({
      id: memory.id,
      version: memory.version,
      claim: memory.claim,
      source: memory.source,
      perceivedKind: memory.perceivedKind as EvidenceMemory['perceivedKind'],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Return current recollections and personal beliefs, with no hack provenance. */
export function accessibleMemories(state: State) {
  const beliefs = Object.values(state.beliefMemories)
    .filter((history) =>
      Object.hasOwn(
        state.beliefs,
        propositionKey(history[history.length - 1].claim),
      ),
    )
    .map((history) => {
      const memory = history[history.length - 1];
      return {
        id: memory.id,
        version: memory.version,
        claim: memory.claim,
        source: memory.source,
        perceivedKind: memory.perceivedKind,
      };
    });
  return [...accessible(state), ...beliefs].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}
