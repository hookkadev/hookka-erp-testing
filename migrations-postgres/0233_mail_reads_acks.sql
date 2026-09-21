-- ---------------------------------------------------------------------------
-- 0233_mail_reads_acks.sql — Mail Center: per-person read state,
-- acknowledgement, blind copies (PRD T-012 R1, R7, R8).
--
-- Why: read state was ONE flag on email_threads, cleared for everyone the
-- moment anyone opened the thread, and there was no way for a sender to ask
-- "did you see this?". Outbound mail also had nowhere to record a Bcc.
--
-- Every statement is idempotent and the SAME DDL self-applies at runtime in
-- src/api/routes/mail-center.ts (ensureMailSchema) — migrations do not
-- auto-run on deploy here, so the route creates these on first use and this
-- file exists so a clean rebuild (db:reset:supabase) stands them up too.
--
-- ⚠ ADAPTER RULE: every *_at column is written by the app via
-- new Date().toISOString(), so it MUST stay TEXT — never timestamptz.
-- ---------------------------------------------------------------------------

-- R1/R2: blind copies on an outbound message (JSON array like to_addresses).
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS bcc_addresses TEXT;
CREATE INDEX IF NOT EXISTS ix_email_messages_provider_msgid
  ON email_messages (provider_message_id);

-- R7: per-person read state. No row ⇒ legacy email_threads.unread applies.
CREATE TABLE IF NOT EXISTS mail_thread_reads (
  org_id TEXT NOT NULL DEFAULT 'hookka',
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  read_at TEXT,
  PRIMARY KEY (org_id, thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_mail_thread_reads_user
  ON mail_thread_reads (org_id, user_id);

-- R8: acknowledgement requests, one row per staff recipient.
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS ack_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS ack_due_at TEXT;
CREATE TABLE IF NOT EXISTS mail_acknowledgements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'hookka',
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  address TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  requested_at TEXT,
  due_at TEXT,
  acked_at TEXT,
  acked_by_user_id TEXT,
  chased_at TEXT,
  chase_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_mail_acks_message
  ON mail_acknowledgements (message_id);
CREATE INDEX IF NOT EXISTS ix_mail_acks_thread
  ON mail_acknowledgements (thread_id);
CREATE INDEX IF NOT EXISTS ix_mail_acks_pending
  ON mail_acknowledgements (org_id, acked_at, due_at);
