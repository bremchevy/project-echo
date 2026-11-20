import { createDatabase } from './database.js';
import { randomUUID } from 'node:crypto';
import { runScenario } from './scenario-data.js';
import { EventStore } from './store.js';
const db = createDatabase();
try {
  const result = await runScenario(new EventStore(db), 'Daniel-' + randomUUID());
  console.log('Faction A accuses the player. Faction B denies it. Daniel sees exonerating evidence.');
  console.log('The player hacks that observation into an incriminating recollection.');
  console.log('Daniel:',result.state.interrogations.at(-1)?.answer);
  console.log('Objective truth: the assassin committed the murder; the player is innocent.');
  console.log('Forensic memory versions:',result.state.memories[result.observation]);
} finally { await db.$disconnect(); }
