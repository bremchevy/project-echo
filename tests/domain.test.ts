import { describe, expect, it } from 'vitest';
import { accessible, emptyState, interrogate, propositionKey, reduce, resolveBeliefs } from '../src/domain.js';
import { murder } from '../src/scenario-data.js';
const testimony = (id:string,polarity:boolean,source:string) => ({id,version:1,claim:{...murder,polarity},source,perceivedKind:'testimony' as const});
describe('pure belief engine',()=>{
  it('handles empty memories',()=>expect(resolveBeliefs([],{})).toEqual({}));
  it('weighs source reliability and records contradictions',()=>{
    const b = resolveBeliefs([testimony('a',true,'A'),testimony('b',false,'B')],{A:0.9,B:0.6})[propositionKey(murder)];
    expect(b.stance).toBe('believes_true');
    expect(b.contradiction).toBe(true);
    expect(b.probability).toBe(0.85714286);
  });
  it('keeps balanced evidence uncertain and input order irrelevant',()=>{
    const m = [testimony('a',true,'A'),testimony('b',false,'B')];
    expect(resolveBeliefs(m,{})).toEqual(resolveBeliefs([...m].reverse(),{}));
    expect(resolveBeliefs(m,{})[propositionKey(murder)].stance).toBe('uncertain');
  });
  it('does not expose objective truth to NPC memory',()=>{
    const s = reduce(emptyState(),{type:'WorldEventOccurred',claim:murder,victim:'v',actualPerpetrator:'player',location:'dock'},'event');
    expect(accessible(s)).toEqual([]);
  });
  it('rejects modifying an unknown memory',()=>expect(()=>reduce(emptyState(),{type:'MemoryModified',memoryId:'missing',claim:murder,actor:'p',method:'hack'},'event')).toThrow('Unknown memory'));
});
describe('interrogation',()=>{
  it('answers uncertainty without inventing evidence for unknown questions',()=>{
    const result = interrogate(emptyState(),{interrogatorId:'i',question:'unknown'});
    expect(result.stance).toBe('uncertain');
    expect(result.citedMemoryIds).toEqual([]);
  });
  it('canonicalizes context key ordering deterministically',()=>{
    const s = emptyState();
    expect(interrogate(s,{question:'q',interrogatorId:'i',seed:'s'})).toEqual(interrogate(s,{seed:'s',interrogatorId:'i',question:'q'}));
  });
});
