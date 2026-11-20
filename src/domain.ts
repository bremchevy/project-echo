import { createHash } from 'node:crypto';
import { z } from 'zod';

export const claimSchema = z.object({
  subject: z.string().min(1), predicate: z.string().min(1),
  object: z.string().min(1), polarity: z.boolean()
}).strict();
const evidence = { memoryId: z.string().uuid(), claim: claimSchema };
export const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('WorldEventOccurred'), claim: claimSchema, victim: z.string(), actualPerpetrator: z.string(), location: z.string() }).strict(),
  z.object({ type: z.literal('ObservationRecorded'), ...evidence, source: z.string() }).strict(),
  z.object({ type: z.literal('TestimonyReceived'), ...evidence, factionId: z.string() }).strict(),
  z.object({ type: z.literal('MemoryModified'), memoryId: z.string().uuid(), claim: claimSchema, actor: z.string(), method: z.string() }).strict(),
  z.object({ type: z.literal('FactionInteraction'), factionId: z.string(), reliability: z.number().min(0.01).max(0.99) }).strict(),
  z.object({ type: z.literal('BeliefStateTransitioned'), proposition: z.string(), oldStance: z.string(), newStance: z.string(), probability: z.number(), evidenceIds: z.array(z.string()) }).strict(),
  z.object({ type: z.literal('InterrogationConducted'), question: z.string(), context: z.object({ interrogatorId: z.string(), question: z.string(), seed: z.string().optional() }), answer: z.string(), citedMemoryIds: z.array(z.string()) }).strict()
]);
export type DomainEvent = z.infer<typeof eventSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Stance = 'believes_true' | 'believes_false' | 'uncertain';
export interface Memory {
  id: string; versionId: string; version: number; previousVersionId?: string;
  kind: 'objective' | 'observation' | 'testimony' | 'belief' | 'external_modification';
  claim: Claim; source: string; perceivedKind: 'observation' | 'testimony';
  provenance: { eventId: string; actor: string; method?: string }[];
}
export interface Belief {
  probability: number; stance: Stance; supporting: { id: string; version: number }[];
  contradicting: { id: string; version: number }[]; contradiction: boolean;
}
export interface State {
  memories: Record<string, Memory[]>; trust: Record<string, number>;
  beliefs: Record<string, Belief>; interrogations: Extract<DomainEvent, {type:'InterrogationConducted'}>[];
}
export const emptyState = (): State => ({ memories: {}, trust: {}, beliefs: {}, interrogations: [] });
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
};
export const propositionKey = (c: Claim) => canonical([c.subject, c.predicate, c.object]);
export const accessible = (s: State) => Object.values(s.memories).map(v => {
  const m = v[v.length - 1];
  return { id: m.id, version: m.version, claim: m.claim, source: m.source, perceivedKind: m.perceivedKind };
}).sort((a,b) => a.id.localeCompare(b.id));
export function resolveBeliefs(memories: ReturnType<typeof accessible>, trust: State['trust']): State['beliefs'] {
  const groups: Record<string, typeof memories> = {};
  for (const m of memories) (groups[propositionKey(m.claim)] ??= []).push(m);
  return Object.fromEntries(Object.entries(groups).sort().map(([key, items]) => {
    let odds = 0;
    const supporting: Belief['supporting'] = [], contradicting: Belief['contradicting'] = [];
    for (const m of [...items].sort((a,b) => a.id.localeCompare(b.id))) {
      const r = m.perceivedKind === 'observation' ? 0.95 : (trust[m.source] ?? 0.65);
      odds += (m.claim.polarity ? 1 : -1) * Math.log(r / (1-r));
      (m.claim.polarity ? supporting : contradicting).push({id:m.id, version:m.version});
    }
    const probability = Number((1 / (1 + Math.exp(-odds))).toFixed(8));
    return [key, { probability, stance: probability >= 0.7 ? 'believes_true' : probability <= 0.3 ? 'believes_false' : 'uncertain', supporting, contradicting, contradiction: supporting.length > 0 && contradicting.length > 0 }];
  }));
}
export function reduce(state: State, event: DomainEvent, eventId: string): State {
  const s = structuredClone(state);
  if (event.type === 'ObservationRecorded' || event.type === 'TestimonyReceived') {
    if (s.memories[event.memoryId]) throw new Error('Memory already exists');
    const observation = event.type === 'ObservationRecorded';
    s.memories[event.memoryId] = [{ id:event.memoryId, versionId:eventId, version:1,
      kind:observation ? 'observation':'testimony', perceivedKind:observation ? 'observation':'testimony',
      claim:event.claim, source:observation ? event.source : event.factionId,
      provenance:[{eventId, actor:observation ? event.source : event.factionId}] }];
  } else if (event.type === 'MemoryModified') {
    const history = s.memories[event.memoryId];
    if (!history) throw new Error('Unknown memory');
    const old = history[history.length-1];
    history.push({...old, versionId:eventId, previousVersionId:old.versionId, version:old.version+1,
      kind:'external_modification', claim:event.claim,
      provenance:[...old.provenance, {eventId, actor:event.actor, method:event.method}]});
  } else if (event.type === 'FactionInteraction') s.trust[event.factionId] = event.reliability;
  else if (event.type === 'InterrogationConducted') s.interrogations.push(event);
  s.beliefs = resolveBeliefs(accessible(s), s.trust);
  return s;
}
export interface DialogueContext { interrogatorId: string; question: string; seed?: string }
export function interrogate(state: State, context: DialogueContext) {
  const b = state.beliefs[context.question];
  const stance = b?.stance ?? 'uncertain';
  const confidence = stance === 'uncertain' ? 'I am unsure' : 'I am confident';
  const templates = ['From what I remember', 'As I recall'];
  const index = createHash('sha256').update(canonical({memories:accessible(state),beliefs:state.beliefs,trust:state.trust,context})).digest()[0] % templates.length;
  const citedMemoryIds = b ? [...b.supporting,...b.contradicting].map(m=>m.id).sort() : [];
  return { answer: templates[index] + ', ' + confidence.toLowerCase() + ': ' + stance + '.',
    stance, confidence, citedMemoryIds };
}
