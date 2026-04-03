-- Migration: 006_goal_event_type
-- Add 'goal' to events.type CHECK constraint

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check
  CHECK (type IN ('mouse', 'scroll', 'idle', 'click', 'form', 'engagement', 'session', 'context', 'cross_session', 'goal'));
