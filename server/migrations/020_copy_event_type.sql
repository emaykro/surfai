-- Migration 020: copy event type + session_features column
-- CopyCollector emits one `copy` event per clipboard copy action.
-- copy_count is the total number of copy actions in the session.
ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_type_check,
  ADD CONSTRAINT events_type_check CHECK (
    type IN (
      'mouse','scroll','idle','click','form','engagement',
      'session','context','cross_session','goal',
      'bot_signals','performance','copy'
    )
  );

ALTER TABLE session_features
  ADD COLUMN IF NOT EXISTS copy_count INTEGER NOT NULL DEFAULT 0;
