-- Migration: 002_expanded_event_types
-- Expand the events.type CHECK constraint to include Phase 2 event types

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check
  CHECK (type IN ('mouse', 'scroll', 'idle', 'click', 'form', 'engagement', 'session', 'context', 'cross_session'));
