import { createDatabase } from '../database.js';
import { randomUUID } from 'node:crypto';
import { runScenario } from './scenario.js';
import { EventStore } from '../events/event-store.js';
import {
  propositionKey,
  resolveForensicBeliefs,
} from '../npc/belief-engine.js';
import { murder } from './scenario.js';
const database = createDatabase();
try {
  const result = await runScenario(
    new EventStore(database),
    'Daniel-' + randomUUID(),
  );
  console.log(
    'Faction A accuses the player. Faction B denies it. Daniel sees exonerating evidence.',
  );
  console.log(
    'The player hacks that observation into an incriminating recollection.',
  );
  console.log('Daniel:', result.state.interrogations.at(-1)?.answer);
  console.log(
    'Objective truth: the assassin committed the murder; the player is innocent.',
  );
  const forensic = resolveForensicBeliefs(result.state);
  console.log('Daniel current stance:', result.answer.stance);
  console.log(
    'Untampered memory stance:',
    forensic.beliefs[propositionKey(murder)].stance,
  );
  console.log(
    'Forensic manipulation trail:',
    JSON.stringify(forensic.manipulations, null, 2),
  );
} finally {
  await database.$disconnect();
}
