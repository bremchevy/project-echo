import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, type Event } from '@prisma/client';
import { canonical } from '../shared/canonical.js';
import { emptyState, type State, type World } from '../npc/memory.js';
import {
  processNpcCommand,
  reduce,
  reduceWorld,
  replayAll,
  type PendingEvent,
} from './processor.js';
import { eventSchema, readEvent, type DomainEvent } from './schema.js';

export class ConcurrencyError extends Error {
  constructor(
    public expected: number,
    public actual: number,
  ) {
    super(
      'Stream version conflict: expected ' + expected + ', actual ' + actual,
    );
    this.name = 'ConcurrencyError';
  }
}
export interface Command {
  aggregateId: string;
  expectedVersion: number;
  idempotencyKey: string;
  event: DomainEvent;
  metadata: { actor: string; causation?: string; correlation?: string };
}

const toJson = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

function validateCommand(command: Command, event: DomainEvent): string {
  if (
    !Number.isInteger(command.expectedVersion) ||
    command.expectedVersion < 0
  ) {
    throw new Error('Invalid expected version');
  }
  const aggregateType = command.aggregateId.split(':')[0];
  if (
    !['npc', 'world', 'faction'].includes(aggregateType) ||
    !command.idempotencyKey ||
    command.idempotencyKey.includes(':derived:')
  ) {
    throw new Error('Invalid stream or key');
  }
  if (
    (aggregateType === 'npc' || aggregateType === 'faction') &&
    !command.aggregateId.split(':')[1]
  ) {
    throw new Error('Missing aggregate identity');
  }
  if (aggregateType === 'world' && event.type !== 'WorldEventOccurred')
    throw new Error('World stream requires objective event');
  if (aggregateType === 'faction' && event.type !== 'FactionInteraction')
    throw new Error('Faction stream requires faction event');
  if (aggregateType === 'npc' && event.type === 'WorldEventOccurred')
    throw new Error('Objective truth requires world stream');
  if (event.type === 'BeliefStateTransitioned')
    throw new Error('Belief transitions are processor-owned');
  return aggregateType;
}

function sameRequest(
  prior: Event,
  command: Command,
  event: DomainEvent,
): boolean {
  const storedEvent = readEvent(prior);
  if (prior.aggregateId !== command.aggregateId) return false;
  if (
    storedEvent.type === 'InterrogationConducted' &&
    event.type === 'InterrogationConducted'
  ) {
    return canonical(storedEvent.context) === canonical(event.context);
  }
  return canonical(storedEvent) === canonical(event);
}

export class EventStore {
  constructor(
    public db: PrismaClient,
    private clock: () => Date = () => new Date(),
    private nextId: () => string = randomUUID,
  ) {}

  /** Atomically append a command, its derived events, and every affected projection. */
  async append(
    command: Command,
  ): Promise<{ events: Event[]; duplicate: boolean }> {
    const event = eventSchema.parse(command.event);
    const aggregateType = validateCommand(command, event);
    try {
      return await this.db.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${command.idempotencyKey}, 0))`;
          const prior = await transaction.event.findUnique({
            where: { idempotencyKey: command.idempotencyKey },
          });
          if (prior) {
            if (!sameRequest(prior, command, event))
              throw new Error('Idempotency key reused for a different command');
            const related = await transaction.event.findMany({
              where: {
                aggregateId: prior.aggregateId,
                metadata: { path: ['causation'], equals: prior.id },
              },
              orderBy: { version: 'asc' },
            });
            const derived = related.filter((row) =>
              row.idempotencyKey.startsWith(
                command.idempotencyKey + ':derived:',
              ),
            );
            derived.forEach(readEvent);
            return { events: [prior, ...derived], duplicate: true };
          }
          await transaction.$executeRaw`INSERT INTO streams (aggregate_id,aggregate_type,version) VALUES (${command.aggregateId},${aggregateType},0) ON CONFLICT DO NOTHING`;
          const locked =
            await transaction.$executeRaw`UPDATE streams SET version=version WHERE aggregate_id=${command.aggregateId} AND version=${command.expectedVersion}`;
          if (!locked) {
            const current = await transaction.stream.findUniqueOrThrow({
              where: { aggregateId: command.aggregateId },
            });
            throw new ConcurrencyError(
              command.expectedVersion,
              current.version,
            );
          }
          const npcId = command.aggregateId.slice(4);
          let npcState: State | undefined;
          let worldState: World | undefined;
          let pending: PendingEvent[];
          if (aggregateType === 'npc') {
            const projection = await transaction.npcState.findUnique({
              where: { npcId },
            });
            const current = projection
              ? (projection.state as unknown as State)
              : emptyState();
            const processed = processNpcCommand(current, event, this.nextId);
            pending = processed.pending;
            npcState = processed.state;
          } else {
            const primaryId = this.nextId();
            pending = [{ id: primaryId, event }];
            if (aggregateType === 'world') {
              const projection = await transaction.worldState.findUnique({
                where: { worldId: command.aggregateId },
              });
              const current = projection
                ? (projection.state as unknown as World)
                : { memories: {} };
              worldState = reduceWorld(current, event, primaryId);
            }
          }
          const nextVersion = command.expectedVersion + pending.length;
          const updated =
            await transaction.$executeRaw`UPDATE streams SET version=${nextVersion} WHERE aggregate_id=${command.aggregateId} AND version=${command.expectedVersion}`;
          if (!updated) {
            const current = await transaction.stream.findUniqueOrThrow({
              where: { aggregateId: command.aggregateId },
            });
            throw new ConcurrencyError(
              command.expectedVersion,
              current.version,
            );
          }
          const occurredAt = this.clock();
          const events: Event[] = [];
          for (const [index, item] of pending.entries()) {
            const parsed = eventSchema.parse(item.event);
            events.push(
              await transaction.event.create({
                data: {
                  id: item.id,
                  aggregateId: command.aggregateId,
                  aggregateType,
                  version: command.expectedVersion + index + 1,
                  eventType: parsed.type,
                  payload: toJson(parsed),
                  metadata: toJson({
                    ...command.metadata,
                    ...(index ? { causation: pending[0].id } : {}),
                  }),
                  idempotencyKey: index
                    ? command.idempotencyKey + ':derived:' + index
                    : command.idempotencyKey,
                  occurredAt,
                },
              }),
            );
          }
          if (npcState) {
            await transaction.npcState.upsert({
              where: { npcId },
              create: { npcId, state: toJson(npcState), version: nextVersion },
              update: { state: toJson(npcState), version: nextVersion },
            });
          }
          if (worldState) {
            await transaction.worldState.upsert({
              where: { worldId: command.aggregateId },
              create: {
                worldId: command.aggregateId,
                state: toJson(worldState),
                version: nextVersion,
              },
              update: { state: toJson(worldState), version: nextVersion },
            });
          }
          return { events, duplicate: false };
        },
        { timeout: 15000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' ||
          (error.code === 'P2010' && error.meta?.code === '23505'))
      ) {
        const stream = await this.db.stream.findUnique({
          where: { aggregateId: command.aggregateId },
        });
        throw new ConcurrencyError(
          command.expectedVersion,
          stream?.version ?? 0,
        );
      }
      throw error;
    }
  }

  /** Reconstruct an NPC from validated recorded events without changing live projections. */
  async rebuildFromLog(npcId: string): Promise<State> {
    const rows = await this.db.event.findMany({
      where: { aggregateId: 'npc:' + npcId },
      orderBy: { version: 'asc' },
    });
    return rows.reduce(
      (state, row) => reduce(state, readEvent(row), row.id),
      emptyState(),
    );
  }

  /** Reconstruct all projections from one committed global log snapshot. */
  async rebuildAll() {
    const rows = await this.db.event.findMany({
      orderBy: { globalPosition: 'asc' },
    });
    return replayAll(rows);
  }

  /** Read an NPC projection, returning an empty state for an unknown NPC. */
  async state(npcId: string): Promise<State> {
    const projection = await this.db.npcState.findUnique({ where: { npcId } });
    return projection ? (projection.state as unknown as State) : emptyState();
  }

  /** Read objective world memory separately from all NPC recollections. */
  async worldState(worldId = 'world'): Promise<World> {
    const projection = await this.db.worldState.findUnique({
      where: { worldId },
    });
    return projection
      ? (projection.state as unknown as World)
      : { memories: {} };
  }
}
