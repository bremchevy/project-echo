import type { Claim } from '../events/schema.js';
import { canonical } from '../shared/canonical.js';
import type { EvidenceMemory, MemoryReference, State } from './memory.js';

export type Stance = 'believes_true' | 'believes_false' | 'uncertain';
export interface Belief {
  probability: number;
  stance: Stance;
  supporting: MemoryReference[];
  contradicting: MemoryReference[];
  contradiction: boolean;
  uncertainty: number;
}
const round = (value: number) => Number(value.toFixed(8));

/** Identify a proposition independently of its asserted polarity. */
export function propositionKey(claim: Claim): string {
  return canonical([claim.subject, claim.predicate, claim.object]);
}

/** Return the signed log-odds magnitude of a memory's apparent source. */
export function evidenceWeight(
  memory: EvidenceMemory,
  trust: State['trust'],
): number {
  const reliability =
    memory.perceivedKind === 'observation'
      ? 0.95
      : Object.hasOwn(trust, memory.source)
        ? trust[memory.source]
        : 0.65;
  if (
    !Number.isFinite(reliability) ||
    reliability < 0.01 ||
    reliability > 0.99
  ) {
    throw new Error('Reliability must be between 0.01 and 0.99');
  }
  return Math.log(reliability / (1 - reliability));
}

/** Resolve evidence deterministically; personal belief memories are never evidence. */
export function resolveBeliefs(
  memories: EvidenceMemory[],
  trust: State['trust'],
): Record<string, Belief> {
  const groupedMemories = new Map<string, EvidenceMemory[]>();
  for (const memory of memories) {
    const proposition = propositionKey(memory.claim);
    groupedMemories.set(proposition, [
      ...(groupedMemories.get(proposition) ?? []),
      memory,
    ]);
  }
  return Object.fromEntries(
    [...groupedMemories.entries()].sort().map(([proposition, evidence]) => {
      let logOdds = 0;
      const supporting: MemoryReference[] = [];
      const contradicting: MemoryReference[] = [];
      for (const memory of evidence.sort((left, right) =>
        left.id.localeCompare(right.id),
      )) {
        const contribution =
          (memory.claim.polarity ? 1 : -1) * evidenceWeight(memory, trust);
        logOdds += contribution;
        (memory.claim.polarity ? supporting : contradicting).push({
          id: memory.id,
          version: memory.version,
        });
      }
      const probability = round(1 / (1 + Math.exp(-logOdds)));
      const entropy =
        probability === 0 || probability === 1
          ? 0
          : -probability * Math.log2(probability) -
            (1 - probability) * Math.log2(1 - probability);
      return [
        proposition,
        {
          probability,
          uncertainty: round(entropy),
          stance:
            probability >= 0.7
              ? 'believes_true'
              : probability <= 0.3
                ? 'believes_false'
                : 'uncertain',
          supporting,
          contradicting,
          contradiction: supporting.length > 0 && contradicting.length > 0,
        },
      ];
    }),
  );
}

/** Reconstruct untampered beliefs from original evidence and expose a system-only hack trail. */
export function resolveForensicBeliefs(state: State) {
  const originals: EvidenceMemory[] = [];
  const manipulations = [];
  for (const history of Object.values(state.memories)) {
    const original = history[0];
    if (
      original.perceivedKind !== 'observation' &&
      original.perceivedKind !== 'testimony'
    )
      continue;
    originals.push({
      id: original.id,
      version: original.version,
      claim: original.claim,
      source: original.source,
      perceivedKind: original.perceivedKind,
    });
    for (const memory of history.filter(
      (version) => version.kind === 'external_modification',
    )) {
      manipulations.push({
        id: memory.id,
        version: memory.version,
        previousVersionId: memory.previousVersionId,
        provenance: structuredClone(memory.provenance),
      });
    }
  }
  manipulations.sort(
    (left, right) =>
      left.id.localeCompare(right.id) || left.version - right.version,
  );
  return { beliefs: resolveBeliefs(originals, state.trust), manipulations };
}
