CREATE TABLE events (
 id uuid PRIMARY KEY, global_position bigserial UNIQUE NOT NULL,
 aggregate_id text NOT NULL, aggregate_type text NOT NULL, version integer NOT NULL CHECK(version > 0),
 event_type text NOT NULL, payload jsonb NOT NULL, metadata jsonb NOT NULL,
 idempotency_key text UNIQUE NOT NULL, occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(aggregate_id, version)
);
CREATE TABLE streams (aggregate_id text PRIMARY KEY, aggregate_type text NOT NULL, version integer NOT NULL);
CREATE TABLE npc_state (npc_id text PRIMARY KEY, state jsonb NOT NULL, version integer NOT NULL);
CREATE FUNCTION reject_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'events are append-only'; END;
$$;
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
