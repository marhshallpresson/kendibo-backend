-- 028_schema_reconcile_ai_agent_matching.sql
-- 1) Reconcile columns the service code already uses but no earlier local
--    migration created (additive, safe to re-run on a database that has them).
-- 2) Storage for the WhatsApp AI agent (conversation memory, captured job
--    requests with photos/budget, signed web-link sessions).
-- 3) Data for the vendor-matching model: every ranking shown is logged with
--    its features so outcomes (accepted / completed / rating) can train it.

-- ── 1. Reconcile ────────────────────────────────────────────────────────────
-- provider.service writes a skill tag (e.g. "electrician"); older rows only
-- have service_id. Named skill_tag, not skill, so it never shadows the table.
ALTER TABLE provider.skill ADD COLUMN IF NOT EXISTS skill_tag TEXT;
-- respondToOffer stamps the acceptance time; offersFor orders by offer time.
ALTER TABLE dispatch.assignment ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE dispatch.assignment ADD COLUMN IF NOT EXISTS offered_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── 2. WhatsApp AI agent ────────────────────────────────────────────────────
-- Rolling conversation memory per WhatsApp user (trimmed to the last N turns
-- in code). Content is what the user typed / the agent replied; tool results
-- are summarised, never raw PII payloads.
CREATE TABLE IF NOT EXISTS messaging.whatsapp_turn (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_turn ON messaging.whatsapp_turn (wa_id, created_at);

-- A job request being assembled in chat: need, category, photos, budget,
-- location (from the map page), then submitted as a booking.service_request.
CREATE TABLE IF NOT EXISTS messaging.whatsapp_job_draft (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id TEXT NOT NULL,
  user_id UUID,
  need TEXT,
  category_id TEXT,
  service_id TEXT,
  budget_kobo BIGINT,
  photo_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  address_text TEXT,
  landmark TEXT,
  scheduled_date DATE,
  time_window TEXT,
  status TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting', 'submitted', 'abandoned')),
  request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_job_draft ON messaging.whatsapp_job_draft (wa_id, status);

-- Budget captured from chat travels with the request to vendors and matching.
ALTER TABLE booking.service_request ADD COLUMN IF NOT EXISTS budget_kobo BIGINT;
ALTER TABLE booking.service_request ADD COLUMN IF NOT EXISTS photo_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ── 3. Matching model ───────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS ml;
-- Versioned model weights (logistic regression over ranking features).
CREATE TABLE IF NOT EXISTS ml.model (
  name TEXT NOT NULL,
  version INT NOT NULL,
  weights JSONB NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  trained_rows INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
-- One row per vendor shown for a request, with the features at that moment.
-- Labels are filled in later from what actually happened.
CREATE TABLE IF NOT EXISTS ml.match_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  provider_id UUID NOT NULL,
  rank INT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  model_version INT NOT NULL DEFAULT 0,
  features JSONB NOT NULL,
  chosen BOOLEAN NOT NULL DEFAULT FALSE,
  accepted BOOLEAN,
  completed BOOLEAN,
  rating INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_match_event_request ON ml.match_event (request_id);
CREATE INDEX IF NOT EXISTS idx_match_event_provider ON ml.match_event (provider_id, created_at);
