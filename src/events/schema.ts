import { z } from 'zod';
import type { Event } from '@prisma/client';

const memoryReference = z.object({
  id: z.string(),
  version: z.number().int().positive(),
});
const interrogationResolution = z.object({
  answer: z.string(),
  stance: z.enum(['believes_true', 'believes_false', 'uncertain']),
  probability: z.number().min(0).max(1),
  citedMemories: z.array(memoryReference),
  acknowledgedContradictions: z.array(memoryReference),
});

export const claimSchema = z
  .object({
    subject: z.string().min(1),
    predicate: z.string().min(1),
    object: z.string().min(1),
    polarity: z.boolean(),
  })
  .strict();
const evidence = { memoryId: z.string().uuid(), claim: claimSchema };
export const eventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('WorldEventOccurred'),
      claim: claimSchema,
      victim: z.string(),
      actualPerpetrator: z.string(),
      location: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('ObservationRecorded'),
      ...evidence,
      source: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('TestimonyReceived'),
      ...evidence,
      factionId: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('MemoryModified'),
      memoryId: z.string().uuid(),
      claim: claimSchema,
      actor: z.string(),
      method: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('FactionInteraction'),
      factionId: z.string(),
      reliability: z.number().min(0.01).max(0.99),
    })
    .strict(),
  z
    .object({
      type: z.literal('BeliefStateTransitioned'),
      proposition: z.string(),
      oldStance: z.string(),
      newStance: z.string(),
      probability: z.number(),
      evidenceIds: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      type: z.literal('InterrogationConducted'),
      question: z.string(),
      context: z.object({
        interrogatorId: z.string(),
        question: z.string(),
        seed: z.string().optional(),
      }),
      answer: z.string(),
      citedMemoryIds: z.array(z.string()),
      resolution: interrogationResolution.optional(),
    })
    .strict(),
]);
export type DomainEvent = z.infer<typeof eventSchema>;
export type Claim = z.infer<typeof claimSchema>;

/** Validate a persisted payload and its event-type discriminator. */
export function readEvent(row: Event): DomainEvent {
  const event = eventSchema.parse(row.payload);
  if (event.type !== row.eventType) throw new Error('Event type mismatch');
  return event;
}
