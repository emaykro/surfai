-- Migration: 009_bot_signals_event_type
-- Add 'bot_signals' to events.type CHECK constraint.
-- Migration 008 added bot detection columns to session_features but forgot
-- to allow the new event type in the events table, causing every batch
-- containing a bot_signals event to be rejected by Postgres.

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check
  CHECK (type IN ('mouse', 'scroll', 'idle', 'click', 'form', 'engagement', 'session', 'context', 'cross_session', 'goal', 'bot_signals'));
