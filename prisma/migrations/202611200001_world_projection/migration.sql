CREATE TABLE world_state (
  world_id text PRIMARY KEY,
  state jsonb NOT NULL,
  version integer NOT NULL
);
