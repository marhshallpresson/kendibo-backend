-- 008_checker.sql — maker-checker second-approval queue (PRD §56).
CREATE SCHEMA IF NOT EXISTS checker;

CREATE TABLE IF NOT EXISTS checker.item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL, ref_id TEXT NOT NULL,
  requested_by TEXT NOT NULL, approved_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
