import { describe, expect, it } from 'vitest';
import {
  accessible,
  emptyState,
  interrogate,
  propositionKey,
  reduce,
  resolveBeliefs,
  resolveForensicBeliefs,
} from '../src/domain.js';
import { murder } from '../src/scenario-data.js';
const testimony = (id: string, polarity: boolean, source: string) => ({
  id,
  version: 1,
  claim: { ...murder, polarity },
  source,
  perceivedKind: 'testimony' as const,
});
describe('pure belief engine', () => {
  it.each([0.2, 0.5])(
    'keeps a denial traceable at faction reliability %s',
    (reliability) => {
      let state = reduce(
        emptyState(),
        { type: 'FactionInteraction', factionId: 'A', reliability: 0.8 },
        'trust-a',
      );
      state = reduce(
        state,
        { type: 'FactionInteraction', factionId: 'B', reliability },
        'trust-b',
      );
      state = reduce(
        state,
        {
          type: 'TestimonyReceived',
          memoryId: 'a',
          claim: murder,
          factionId: 'A',
        },
        'accusation',
      );
      state = reduce(
        state,
        {
          type: 'TestimonyReceived',
          memoryId: 'b',
          claim: { ...murder, polarity: false },
          factionId: 'B',
        },
        'denial',
      );
      const belief = state.beliefs[propositionKey(murder)];
      expect(belief.supporting).toEqual([{ id: 'a', version: 1 }]);
      expect(belief.contradicting).toEqual([{ id: 'b', version: 1 }]);
      expect(belief.contradiction).toBe(true);
      expect(belief.probability).toBe(reliability === 0.2 ? 0.94117647 : 0.8);
      const answer = interrogate(state, {
        interrogatorId: 'detective',
        question: propositionKey(murder),
      });
      expect(answer.answer).toContain(
        'Faction B told me the player did not commit the murder',
      );
      expect(answer.acknowledgedContradictions).toEqual([
        { id: 'b', version: 1 },
      ]);
      expect(answer.citedMemories).toContainEqual({ id: 'b', version: 1 });
    },
  );
  it('does not label agreeing claims as contradictory merely because source trust differs', () => {
    const belief = resolveBeliefs(
      [testimony('a', true, 'A'), testimony('b', true, 'B')],
      { A: 0.8, B: 0.2 },
    )[propositionKey(murder)];
    expect(belief.supporting).toEqual([
      { id: 'a', version: 1 },
      { id: 'b', version: 1 },
    ]);
    expect(belief.contradicting).toEqual([]);
    expect(belief.contradiction).toBe(false);
    expect(belief.probability).toBe(0.5);
  });
  it('handles empty memories', () =>
    expect(resolveBeliefs([], {})).toEqual({}));
  it('weighs source reliability and records contradictions', () => {
    const belief = resolveBeliefs(
      [testimony('a', true, 'A'), testimony('b', false, 'B')],
      { A: 0.9, B: 0.6 },
    )[propositionKey(murder)];
    expect(belief.stance).toBe('believes_true');
    expect(belief.contradiction).toBe(true);
    expect(belief.probability).toBe(0.85714286);
  });
  it('keeps balanced evidence uncertain and input order irrelevant', () => {
    const memories = [testimony('a', true, 'A'), testimony('b', false, 'B')];
    expect(resolveBeliefs(memories, {})).toEqual(
      resolveBeliefs([...memories].reverse(), {}),
    );
    expect(resolveBeliefs(memories, {})[propositionKey(murder)].stance).toBe(
      'uncertain',
    );
  });
  it('quantifies uncertainty as binary entropy', () => {
    const balanced = resolveBeliefs(
      [testimony('a', true, 'A'), testimony('b', false, 'B')],
      {},
    );
    expect(balanced[propositionKey(murder)].uncertainty).toBe(1);
    const confident = resolveBeliefs([testimony('a', true, 'A')], { A: 0.99 });
    expect(confident[propositionKey(murder)].uncertainty).toBeGreaterThan(0);
    expect(confident[propositionKey(murder)].uncertainty).toBeLessThan(0.1);
  });
  it('rejects invalid reliability and returns empty forensic results without memories', () => {
    expect(() => resolveBeliefs([testimony('a', true, 'A')], { A: 2 })).toThrow(
      'Reliability',
    );
    expect(resolveForensicBeliefs(emptyState())).toEqual({
      beliefs: {},
      manipulations: [],
    });
  });
  it('does not expose objective truth to NPC memory', () => {
    const state = reduce(
      emptyState(),
      {
        type: 'WorldEventOccurred',
        claim: murder,
        victim: 'v',
        actualPerpetrator: 'player',
        location: 'dock',
      },
      'event',
    );
    expect(accessible(state)).toEqual([]);
  });
  it('rejects modifying an unknown memory', () =>
    expect(() =>
      reduce(
        emptyState(),
        {
          type: 'MemoryModified',
          memoryId: 'missing',
          claim: murder,
          actor: 'p',
          method: 'hack',
        },
        'event',
      ),
    ).toThrow('Unknown memory'));
});
describe('interrogation', () => {
  it('names the strongest perceived testimony and hedges a moderate-confidence belief', () => {
    const state = reduce(
      emptyState(),
      {
        type: 'TestimonyReceived',
        memoryId: 'memory',
        claim: murder,
        factionId: 'A',
      },
      'event',
    );
    state.trust.A = 0.75;
    state.beliefs = resolveBeliefs(accessible(state), state.trust);
    const result = interrogate(state, {
      interrogatorId: 'detective',
      question: propositionKey(murder),
    });
    expect(result.answer).toContain('I think the player committed the murder');
    expect(result.answer).toContain('Faction A told me');
    expect(result.citedMemories).toEqual([{ id: 'memory', version: 1 }]);
    expect(result.acknowledgedContradictions).toEqual([]);
  });
  it('hedges balanced evidence and states innocence when exonerating observation dominates', () => {
    let state = reduce(
      emptyState(),
      {
        type: 'TestimonyReceived',
        memoryId: 'a',
        claim: murder,
        factionId: 'A',
      },
      'first',
    );
    state = reduce(
      state,
      {
        type: 'TestimonyReceived',
        memoryId: 'b',
        claim: { ...murder, polarity: false },
        factionId: 'B',
      },
      'second',
    );
    const context = {
      interrogatorId: 'detective',
      question: propositionKey(murder),
    };
    expect(interrogate(state, context).answer).toContain("I can't be sure");
    state = reduce(
      state,
      {
        type: 'ObservationRecorded',
        memoryId: 'observation',
        claim: { ...murder, polarity: false },
        source: 'physical',
      },
      'third',
    );
    expect(interrogate(state, context).answer).toContain(
      'the player did not commit the murder',
    );
  });
  it('answers uncertainty without inventing evidence for unknown questions', () => {
    const result = interrogate(emptyState(), {
      interrogatorId: 'i',
      question: 'unknown',
    });
    expect(result.stance).toBe('uncertain');
    expect(result.citedMemories).toEqual([]);
  });
  it('canonicalizes context key ordering deterministically', () => {
    const state = emptyState();
    expect(
      interrogate(state, { question: 'q', interrogatorId: 'i', seed: 's' }),
    ).toEqual(
      interrogate(state, { seed: 's', interrogatorId: 'i', question: 'q' }),
    );
  });
});
