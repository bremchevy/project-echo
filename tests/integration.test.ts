import { createDatabase } from '../src/database.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { accessible, interrogate, propositionKey } from '../src/domain.js';
import { ConcurrencyError, EventStore, readEvent, type Command } from '../src/store.js';
import { murder, runScenario } from '../src/scenario-data.js';
const db = createDatabase();
const store = new EventStore(db,()=>new Date('2026-01-01T00:00:00Z'));
beforeEach(async()=> { await db.$executeRawUnsafe('TRUNCATE events, streams, npc_state RESTART IDENTITY'); });
afterAll(async()=> { await db.$disconnect(); });
const command = (): Command => ({aggregateId:'npc:Daniel',expectedVersion:0,idempotencyKey:randomUUID(),
  event:{type:'TestimonyReceived',memoryId:randomUUID(),claim:murder,factionId:'A'},metadata:{actor:'A'}});
describe('Daniel integration',()=>{
  it('answers from hacked beliefs rather than objective truth',async()=>{
    const r = await runScenario(store);
    expect(r.beforeHack.beliefs[propositionKey(murder)].stance).toBe('believes_false');
    expect(r.answer.stance).toBe('believes_true');
    expect(r.state.interrogations[0].answer).toContain('believes_true');
    expect(accessible(r.state)).toHaveLength(3);
    expect((await db.event.findFirstOrThrow({where:{eventType:'WorldEventOccurred'}})).payload).toMatchObject({actualPerpetrator:'assassin'});
  });
  it('retains every original event and its supplied timestamp',async()=>{
    await runScenario(store);
    const rows = await db.event.findMany();
    expect(rows.map(readEvent).filter(e=>e.type==='TestimonyReceived')).toHaveLength(2);
    expect(rows.map(readEvent).filter(e=>e.type==='ObservationRecorded')).toHaveLength(1);
    expect(rows.every(r=>r.occurredAt.toISOString()==='2026-01-01T00:00:00.000Z')).toBe(true);
  });
  it('creates a new linked memory version and hides hack provenance in accessible view',async()=>{
    const r = await runScenario(store), history = r.state.memories[r.observation];
    expect(history).toHaveLength(2);
    expect(history[0].claim.polarity).toBe(false);
    expect(history[1]).toMatchObject({version:2,previousVersionId:history[0].versionId,kind:'external_modification'});
    expect(history[1].provenance.at(-1)).toMatchObject({actor:'player',method:'neural-write'});
    expect(accessible(r.state).find(m=>m.id===r.observation)).not.toHaveProperty('provenance');
  });
  it('keeps conflicting evidence traceable',async()=>{
    const r = await runScenario(store), belief = r.state.beliefs[propositionKey(murder)];
    expect(belief.contradiction).toBe(true);
    expect(belief.supporting).toContainEqual({id:r.observation,version:2});
    expect(belief.contradicting).toContainEqual({id:r.b,version:1});
  });
  it('replays to exactly the transactional projection',async()=>{
    const r = await runScenario(store);
    expect(await store.rebuildFromLog('Daniel')).toEqual(r.state);
  });
  it('does not execute duplicate events or projections twice',async()=>{
    const c = command(), first = await store.append(c), state = await store.state('Daniel');
    const duplicate = await store.append(c);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.events).toEqual(first.events);
    expect(await store.state('Daniel')).toEqual(state);
    expect(await db.event.count()).toBe(first.events.length);
  });
  it('allows exactly one concurrent expected-version update without loss',async()=>{
    const results = await Promise.allSettled([store.append(command()),store.append(command())]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const failure = results.find(r=>r.status==='rejected') as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(ConcurrencyError);
    expect(failure.reason.expected).toBe(0);
    expect(failure.reason.actual).toBe(2);
    expect(await db.event.count()).toBe(2);
    expect(await store.rebuildFromLog('Daniel')).toEqual(await store.state('Daniel'));
  });
  it('does not confuse later causally linked commands with derived events on retry',async()=>{
    const c = command(), first = await store.append(c);
    await store.append({...command(),expectedVersion:2,metadata:{actor:'A',causation:first.events[0].id}});
    expect((await store.append(c)).events).toEqual(first.events);
  });
  it('serializes concurrent duplicate submissions to one primary event',async()=>{
    const c: Command = {...command(),event:{type:'FactionInteraction',factionId:'A',reliability:0.7}};
    const results = await Promise.all([store.append(c),store.append(c)]);
    expect(results.map(r=>r.duplicate).sort()).toEqual([false,true]);
    expect(await db.event.count({where:{idempotencyKey:c.idempotencyKey}})).toBe(1);
    expect(await db.event.count()).toBe(1);
  });
  it('rejects UPDATE and DELETE at database level',async()=>{
    await store.append(command());
    await expect(db.$executeRawUnsafe("UPDATE events SET event_type='changed'")).rejects.toThrow('append-only');
    await expect(db.$executeRawUnsafe('DELETE FROM events')).rejects.toThrow('append-only');
  });
  it('returns deterministic interrogation for identical state and context',async()=>{
    const r = await runScenario(store);
    expect(interrogate(r.state,r.context)).toEqual(interrogate(structuredClone(r.state),{...r.context}));
  });
  it('rolls back the stream, events and projection on invalid memory modification',async()=>{
    const c = command();
    await expect(store.append({...c,event:{type:'MemoryModified',memoryId:randomUUID(),claim:murder,actor:'player',method:'hack'}})).rejects.toThrow('Unknown memory');
    expect(await db.event.count()).toBe(0);
    expect(await db.stream.count()).toBe(0);
    expect(await db.npcState.count()).toBe(0);
  });
  it('validates events on append and read, rejecting key reuse',async()=>{
    const c = command();
    await expect(store.append({...c,event:{type:'Invalid'} as never})).rejects.toThrow();
    const result = await store.append(c);
    expect(()=>readEvent({...result.events[0],payload:{type:'Invalid'}})).toThrow();
    await expect(store.append({...c,event:{type:'FactionInteraction',factionId:'A',reliability:0.5}})).rejects.toThrow('Idempotency key reused');
  });
  it('replays an empty log and keeps projection version equal to its stream',async()=>{
    expect(await store.rebuildFromLog('missing')).toEqual(await store.state('missing'));
    const r = await runScenario(store);
    expect((await db.npcState.findUniqueOrThrow({where:{npcId:'Daniel'}})).version).toBe(r.version);
    expect((await db.stream.findUniqueOrThrow({where:{aggregateId:'npc:Daniel'}})).version).toBe(r.version);
  });
});
