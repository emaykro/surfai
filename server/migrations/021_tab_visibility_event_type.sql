-- Migration 021: tab_visibility event type + session_features columns
-- TabVisibilityCollector emits one summary event per session via beforeFlush.
-- tab_blur_count: how many times the user hid this tab (0 = never left).
-- tab_hidden_ms: total milliseconds the tab was hidden.
ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_type_check,
  ADD CONSTRAINT events_type_check CHECK (
    type IN (
      'mouse','scroll','idle','click','form','engagement',
      'session','context','cross_session','goal',
      'bot_signals','performance','copy','tab_visibility'
    )
  );

ALTER TABLE session_features
  ADD COLUMN IF NOT EXISTS tab_blur_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tab_hidden_ms   INTEGER NOT NULL DEFAULT 0;
