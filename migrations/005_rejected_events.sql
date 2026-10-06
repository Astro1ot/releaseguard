CREATE TABLE rejected_events (
  topic text NOT NULL,
  partition_id integer NOT NULL,
  event_offset text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('invalid_payload', 'unrecognized_event')),
  rejected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic, partition_id, event_offset)
);
