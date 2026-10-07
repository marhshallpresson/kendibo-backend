-- 006_checklist.sql — persisted per-job checklist completions (completion gate).
CREATE TABLE IF NOT EXISTS booking.checklist_done (
  job_id TEXT NOT NULL, item TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, item)
);
