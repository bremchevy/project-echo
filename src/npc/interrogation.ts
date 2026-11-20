import { createHash } from 'node:crypto';
import { canonical } from '../shared/canonical.js';
import {
  evidenceWeight,
  propositionKey,
  type Stance,
} from './belief-engine.js';
import {
  accessible,
  type EvidenceMemory,
  type MemoryReference,
  type State,
} from './memory.js';

export interface DialogueContext {
  interrogatorId: string;
  question: string;
  seed?: string;
}
export interface InterrogationAnswer {
  answer: string;
  stance: Stance;
  probability: number;
  citedMemories: MemoryReference[];
  acknowledgedContradictions: MemoryReference[];
}

function describeProposition(
  memory: EvidenceMemory,
  positive: boolean,
): string {
  const { subject, predicate, object } = memory.claim;
  const subjectText = subject === 'player' ? 'the player' : subject;
  if (predicate === 'murdered') {
    return (
      subjectText +
      (positive ? ' committed the murder' : ' did not commit the murder') +
      (object === 'victim' ? '' : ' of ' + object)
    );
  }
  return (
    'the claim "' +
    subjectText +
    ' ' +
    predicate +
    ' ' +
    object +
    '" is ' +
    (positive ? 'true' : 'false')
  );
}

function describeSource(memory: EvidenceMemory): string {
  if (memory.perceivedKind === 'observation') return 'I saw it myself';
  const faction = memory.source.startsWith('Faction ')
    ? memory.source
    : 'Faction ' + memory.source;
  return faction + ' told me';
}

/** Answer only from accessible evidence and the matching current belief. */
export function interrogate(
  state: State,
  context: DialogueContext,
): InterrogationAnswer {
  const belief = Object.hasOwn(state.beliefs, context.question)
    ? state.beliefs[context.question]
    : undefined;
  const evidence = accessible(state).filter(
    (memory) => propositionKey(memory.claim) === context.question,
  );
  if (!belief || evidence.length === 0) {
    return {
      answer: "I don't remember anything that would let me answer that.",
      stance: 'uncertain',
      probability: 0.5,
      citedMemories: [],
      acknowledgedContradictions: [],
    };
  }
  const orderedEvidence = [...evidence].sort(
    (left, right) =>
      Math.abs(evidenceWeight(right, state.trust)) -
        Math.abs(evidenceWeight(left, state.trust)) ||
      left.id.localeCompare(right.id),
  );
  const positive = belief.probability >= 0.5;
  const supportingReferences = positive
    ? belief.supporting
    : belief.contradicting;
  const opposingReferences = positive
    ? belief.contradicting
    : belief.supporting;
  const strongestMemory =
    orderedEvidence.find((memory) =>
      supportingReferences.some(
        (reference) =>
          reference.id === memory.id && reference.version === memory.version,
      ),
    ) ?? orderedEvidence[0];
  const opposingMemories = orderedEvidence.filter((memory) =>
    opposingReferences.some(
      (reference) =>
        reference.id === memory.id && reference.version === memory.version,
    ),
  );
  const certainty = Math.max(belief.probability, 1 - belief.probability);
  const confidence =
    belief.stance === 'uncertain'
      ? belief.probability === 0.5
        ? "I can't be sure whether "
        : "I can't be sure, but I lean toward thinking "
      : certainty >= 0.9
        ? "I'm convinced "
        : 'I think ';
  const openings = ['', 'As I remember it, '];
  const digest = createHash('sha256')
    .update(canonical({ belief, evidence, context }))
    .digest();
  const statement = describeProposition(strongestMemory, positive);
  const recollection =
    describeSource(strongestMemory) +
    (strongestMemory.perceivedKind === 'observation'
      ? '.'
      : ' ' +
        describeProposition(strongestMemory, strongestMemory.claim.polarity) +
        '.');
  const contradiction = opposingMemories.length
    ? ' Still, ' +
      opposingMemories
        .map((memory) =>
          memory.perceivedKind === 'testimony'
            ? describeSource(memory) +
              ' ' +
              describeProposition(memory, memory.claim.polarity)
            : 'I also remember seeing evidence that ' +
              describeProposition(memory, memory.claim.polarity),
        )
        .join('; ') +
      ", so I know the accounts don't all agree."
    : '';
  const citedMemories = [strongestMemory, ...opposingMemories].map(
    ({ id, version }) => ({ id, version }),
  );
  return {
    answer:
      openings[digest[0] % openings.length] +
      confidence +
      statement +
      '. ' +
      recollection +
      contradiction,
    stance: belief.stance,
    probability: belief.probability,
    citedMemories,
    acknowledgedContradictions: opposingMemories.map(({ id, version }) => ({
      id,
      version,
    })),
  };
}
