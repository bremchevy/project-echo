import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, type Event } from '@prisma/client';
import { canonical, emptyState, eventSchema, interrogate, reduce, type DomainEvent, type State } from './domain.js';

export class ConcurrencyError extends Error {
  constructor(public expected: number, public actual: number) {
    super('Stream version conflict: expected ' + expected + ', actual ' + actual);
    this.name = 'ConcurrencyError';
  }
}
export interface Command {
  aggregateId: string; expectedVersion: number; idempotencyKey: string;
  event: DomainEvent;
  metadata: { actor: string; causation?: string; correlation?: string };
}
export function readEvent(row: Event): DomainEvent {
  const event = eventSchema.parse(row.payload);
  if (event.type !== row.eventType) throw new Error('Event type mismatch');
  return event;
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export class EventStore {
  constructor(public db: PrismaClient, private clock: () => Date = () => new Date(), private id: () => string = randomUUID) {}
  async append(command: Command): Promise<{events: Event[]; duplicate: boolean}> {
    const event = eventSchema.parse(command.event);
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 0) throw new Error('Invalid expected version');
    const aggregateType = command.aggregateId.split(':')[0];
    if (!['npc','world','faction'].includes(aggregateType) || !command.idempotencyKey || command.idempotencyKey.includes(':derived:')) throw new Error('Invalid stream or key');
    if ((aggregateType === 'npc' || aggregateType === 'faction') && !command.aggregateId.split(':')[1]) throw new Error('Missing aggregate identity');
    if (aggregateType === 'world' && event.type !== 'WorldEventOccurred') throw new Error('World stream requires objective event');
    if (aggregateType !== 'npc' && !['WorldEventOccurred','FactionInteraction'].includes(event.type)) throw new Error('NPC event requires NPC stream');
    if (aggregateType === 'npc' && event.type === 'WorldEventOccurred') throw new Error('Objective truth requires world stream');
    if (event.type === 'BeliefStateTransitioned') throw new Error('Belief transitions are processor-owned');
    try {
      return await this.db.$transaction(async tx => {
        // Serialize duplicate commands before the stream CAS, even across aggregates.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${command.idempotencyKey}, 0))`;
        const prior = await tx.event.findUnique({where:{idempotencyKey:command.idempotencyKey}});
        if (prior) {
          if (prior.aggregateId !== command.aggregateId || canonical(readEvent(prior)) !== canonical(event)) {
            // Interrogation answers are processor-owned and are compared by request below.
            const p = readEvent(prior);
            if (!(p.type === 'InterrogationConducted' && event.type === 'InterrogationConducted' &&
              prior.aggregateId === command.aggregateId && canonical(p.context) === canonical(event.context))) throw new Error('Idempotency key reused for a different command');
          }
          const derived = await tx.event.findMany({where:{aggregateId:prior.aggregateId,idempotencyKey:{startsWith:command.idempotencyKey + ':derived:'}},orderBy:{version:'asc'}});
          derived.forEach(readEvent);
          return {events:[prior,...derived],duplicate:true};
        }
        await tx.$executeRaw`INSERT INTO streams (aggregate_id,aggregate_type,version) VALUES (${command.aggregateId},${aggregateType},0) ON CONFLICT DO NOTHING`;
        // A no-op conditional update acquires the stream lock and checks the caller's version.
        const locked = await tx.$executeRaw`UPDATE streams SET version=version WHERE aggregate_id=${command.aggregateId} AND version=${command.expectedVersion}`;
        if (!locked) {
          const current = await tx.stream.findUniqueOrThrow({where:{aggregateId:command.aggregateId}});
          throw new ConcurrencyError(command.expectedVersion,current.version);
        }
        const npcId = command.aggregateId.slice(4);
        const projection = aggregateType === 'npc' ? await tx.npcState.findUnique({where:{npcId}}) : null;
        let state = projection ? projection.state as unknown as State : emptyState();
        let actualEvent = event;
        if (event.type === 'InterrogationConducted') {
          const result = interrogate(state,event.context);
          actualEvent = {...event, question:event.context.question, answer:result.answer, citedMemoryIds:result.citedMemoryIds};
        }
        const occurredAt = this.clock();
        const firstId = this.id();
        const pending: {id:string; event:DomainEvent}[] = [{id:firstId,event:actualEvent}];
        if (aggregateType === 'npc') {
          const old = state;
          state = reduce(state,actualEvent,firstId);
          for (const [proposition,b] of Object.entries(state.beliefs)) {
            if (canonical(old.beliefs[proposition] ?? null) !== canonical(b)) pending.push({id:this.id(),event:{
              type:'BeliefStateTransitioned',proposition,oldStance:old.beliefs[proposition]?.stance ?? 'uncertain',
              newStance:b.stance,probability:b.probability,evidenceIds:[...b.supporting,...b.contradicting].map(m=>m.id)
            }});
          }
        }
        const nextVersion = command.expectedVersion + pending.length;
        const updated = await tx.$executeRaw`UPDATE streams SET version=${nextVersion} WHERE aggregate_id=${command.aggregateId} AND version=${command.expectedVersion}`;
        if (!updated) throw new ConcurrencyError(command.expectedVersion, nextVersion);
        const events: Event[] = [];
        for (const [index,item] of pending.entries()) {
          const parsed = eventSchema.parse(item.event);
          events.push(await tx.event.create({data:{
            id:item.id,aggregateId:command.aggregateId,aggregateType,version:command.expectedVersion+index+1,
            eventType:parsed.type,payload:json(parsed),metadata:json({...command.metadata,...(index ? {causation:firstId} : {})}),
            idempotencyKey:index ? command.idempotencyKey + ':derived:' + index : command.idempotencyKey,occurredAt
          }}));
          if (index && aggregateType === 'npc') state = reduce(state,parsed,item.id);
        }
        if (aggregateType === 'npc') await tx.npcState.upsert({where:{npcId},
          create:{npcId,state:json(state),version:nextVersion},update:{state:json(state),version:nextVersion}});
        return {events,duplicate:false};
      }, {timeout:15000});
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || (error.code === 'P2010' && error.meta?.code === '23505'))) {
        const stream = await this.db.stream.findUnique({where:{aggregateId:command.aggregateId}});
        throw new ConcurrencyError(command.expectedVersion,stream?.version ?? 0);
      }
      throw error;
    }
  }
  async rebuildFromLog(npcId: string): Promise<State> {
    const rows = await this.db.event.findMany({where:{aggregateId:'npc:'+npcId},orderBy:{version:'asc'}});
    return rows.reduce((s,row)=>reduce(s,readEvent(row),row.id),emptyState());
  }
  async state(npcId: string): Promise<State> {
    const row = await this.db.npcState.findUnique({where:{npcId}});
    return row ? row.state as unknown as State : emptyState();
  }
}
