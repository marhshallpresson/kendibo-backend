-- 003_prd_entities.sql — full PRD Appendix B data model.
-- Conventions: UUID PKs, TIMESTAMPTZ (UTC), money BIGINT kobo CHECK>0,
-- currency CHECK='NGN'. Lat/lng as DOUBLE (PostGIS optional, never required).
-- Extends 001_core.sql (identity.users, booking.booking, payment.*, ledger.*,
-- dispatch.assignment, geo.provider_location, outbox_event).

CREATE SCHEMA IF NOT EXISTS property;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS provider;
CREATE SCHEMA IF NOT EXISTS messaging;
CREATE SCHEMA IF NOT EXISTS notification;
CREATE SCHEMA IF NOT EXISTS support;
CREATE SCHEMA IF NOT EXISTS b2b;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS configuration;

-- ---------- users & profiles ----------
ALTER TABLE identity.users
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS profile_image TEXT,
  ADD COLUMN IF NOT EXISTS pin_hash TEXT,
  ADD COLUMN IF NOT EXISTS biometric BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS identity.customer_profile (
  user_id UUID PRIMARY KEY REFERENCES identity.users(id),
  preferences JSONB NOT NULL DEFAULT '{}',
  notification_preferences JSONB NOT NULL DEFAULT '{"push":true,"sms":true}',
  marketing_consent BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS identity.device (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  platform TEXT NOT NULL, push_token TEXT NOT NULL UNIQUE,
  channel TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- geo reference: cities & zones (data, never code) ----------
CREATE TABLE IF NOT EXISTS geo.city (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  radius_km DOUBLE PRECISION NOT NULL DEFAULT 12,
  vat_bps INTEGER NOT NULL DEFAULT 750,
  emergency_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  flags JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS geo.zone (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id TEXT NOT NULL REFERENCES geo.city(id),
  name TEXT NOT NULL, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
  radius_km DOUBLE PRECISION NOT NULL DEFAULT 8,
  UNIQUE (city_id, name)
);

-- ---------- properties & addresses & assets ----------
CREATE TABLE IF NOT EXISTS property.address (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  lat DOUBLE PRECISION, lng DOUBLE PRECISION, accuracy DOUBLE PRECISION,
  street TEXT, house_number TEXT, estate TEXT, building TEXT,
  unit TEXT, floor TEXT, landmark TEXT, gate_notes TEXT,
  contact_phone TEXT NOT NULL, postcode TEXT,
  zone_id UUID REFERENCES geo.zone(id),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS property.property (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES identity.users(id),
  organisation_id UUID,
  name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'House',
  address_id UUID REFERENCES property.address(id),
  access_notes TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS property.asset (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property.property(id),
  category TEXT NOT NULL, brand TEXT, model TEXT, serial_number TEXT,
  installation_date DATE, purchase_date DATE, warranty_end DATE,
  service_interval_days INTEGER, condition TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS property.history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property.property(id),
  kind TEXT NOT NULL, label TEXT NOT NULL, ref_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS property.reminder (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES property.property(id),
  asset_id UUID REFERENCES property.asset(id),
  message TEXT NOT NULL, due_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS property.recurring (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  property_id UUID NOT NULL REFERENCES property.property(id),
  service_id TEXT NOT NULL, frequency TEXT NOT NULL,
  start_date DATE NOT NULL, end_date DATE,
  time_window TEXT NOT NULL, payment_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- catalog ----------
CREATE TABLE IF NOT EXISTS catalog.category (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  description TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS catalog.service (
  id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES catalog.category(id),
  name TEXT NOT NULL, description TEXT,
  booking_type TEXT NOT NULL DEFAULT 'fixed_price',
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  base_price_kobo BIGINT NOT NULL DEFAULT 0 CHECK (base_price_kobo >= 0),
  warranty_days INTEGER NOT NULL DEFAULT 7,
  requires_skill TEXT, active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS catalog.addon (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES catalog.service(id),
  name TEXT NOT NULL, price_kobo BIGINT NOT NULL CHECK (price_kobo > 0),
  rules JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS catalog.checklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id TEXT NOT NULL REFERENCES catalog.category(id),
  items JSONB NOT NULL, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS catalog.pricebook (
  version TEXT PRIMARY KEY, vat_bps INTEGER NOT NULL DEFAULT 750,
  platform_fee_bps INTEGER NOT NULL DEFAULT 1000,
  per_km_kobo BIGINT NOT NULL DEFAULT 20000,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- providers ----------
CREATE TABLE IF NOT EXISTS provider.provider (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  business_name TEXT, kyc_status TEXT NOT NULL DEFAULT 'PENDING',
  verify_level TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'active',
  rating DOUBLE PRECISION NOT NULL DEFAULT 5.0,
  completion_rate DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  service_radius_km DOUBLE PRECISION NOT NULL DEFAULT 15,
  zone_id UUID REFERENCES geo.zone(id),
  lat DOUBLE PRECISION, lng DOUBLE PRECISION, online BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS provider.skill (
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  service_id TEXT NOT NULL, experience_years INTEGER NOT NULL DEFAULT 0,
  qualification TEXT, verified BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (provider_id, service_id)
);
CREATE TABLE IF NOT EXISTS provider.availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  date DATE NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS provider.quality (
  provider_id UUID PRIMARY KEY REFERENCES provider.provider(id),
  response_rate DOUBLE PRECISION NOT NULL DEFAULT 1,
  acceptance_rate DOUBLE PRECISION NOT NULL DEFAULT 1,
  on_time DOUBLE PRECISION NOT NULL DEFAULT 1,
  completion DOUBLE PRECISION NOT NULL DEFAULT 1,
  cancellations INTEGER NOT NULL DEFAULT 0,
  disputes INTEGER NOT NULL DEFAULT 0,
  warranties INTEGER NOT NULL DEFAULT 0,
  reschedules INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS provider.earning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  job_id TEXT NOT NULL, amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  tip_kobo BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- jobs, quotes, evidence ----------
ALTER TABLE booking.booking
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES identity.users(id),
  ADD COLUMN IF NOT EXISTS property_id UUID,
  ADD COLUMN IF NOT EXISTS provider_id UUID,
  ADD COLUMN IF NOT EXISTS booking_type TEXT NOT NULL DEFAULT 'fixed_price',
  ADD COLUMN IF NOT EXISTS start_window TEXT,
  ADD COLUMN IF NOT EXISTS urgency TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS customer_notes TEXT,
  ADD COLUMN IF NOT EXISTS end_window TEXT,
  ADD COLUMN IF NOT EXISTS duration_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS quote_id UUID,
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS warranty_id UUID,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS booking.quote (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL, provider_id TEXT,
  version INTEGER NOT NULL,
  issue_summary TEXT, diagnosis TEXT,
  labour_kobo BIGINT NOT NULL DEFAULT 0, parts_kobo BIGINT NOT NULL DEFAULT 0,
  fees_kobo BIGINT NOT NULL DEFAULT 0, tax_kobo BIGINT NOT NULL DEFAULT 0,
  discount_kobo BIGINT NOT NULL DEFAULT 0, total_kobo BIGINT NOT NULL CHECK (total_kobo >= 0),
  valid_until TIMESTAMPTZ, warranty_days INTEGER NOT NULL DEFAULT 7,
  assumptions JSONB NOT NULL DEFAULT '[]', exclusions JSONB NOT NULL DEFAULT '[]',
  attachments JSONB NOT NULL DEFAULT '[]', provider_notes TEXT,
  status TEXT NOT NULL DEFAULT 'proposed', locked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, version)
);
CREATE TABLE IF NOT EXISTS booking.change_order (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL, quote_id UUID REFERENCES booking.quote(id),
  reason TEXT NOT NULL, amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  evidence JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'requested',
  approved_by TEXT, approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS booking.evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL, type TEXT NOT NULL,
  url TEXT NOT NULL, sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS booking.reschedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL, from_slot TEXT NOT NULL, to_slot TEXT NOT NULL,
  actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- money: payouts, refunds, disputes, warranty, support ----------
CREATE TABLE IF NOT EXISTS payment.payout (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL, amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  currency TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status TEXT NOT NULL DEFAULT 'pending',
  psp_reference TEXT, approved_by TEXT, paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment.refund (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL, amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'requested',
  psp_reference TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment.dispute (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL, opened_by TEXT NOT NULL,
  reason TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'normal',
  resolution TEXT, case_file JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment.warranty (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL, policy TEXT NOT NULL DEFAULT 'standard',
  start_date DATE NOT NULL DEFAULT CURRENT_DATE, end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS payment.warranty_claim (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warranty_id UUID NOT NULL REFERENCES payment.warranty(id),
  reason TEXT NOT NULL, description TEXT, evidence JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'submitted', resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment.review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL, provider_id UUID,
  provider INTEGER NOT NULL CHECK (provider BETWEEN 1 AND 5),
  quality INTEGER NOT NULL CHECK (quality BETWEEN 1 AND 5),
  punctuality INTEGER NOT NULL CHECK (punctuality BETWEEN 1 AND 5),
  professionalism INTEGER NOT NULL CHECK (professionalism BETWEEN 1 AND 5),
  result INTEGER NOT NULL CHECK (result BETWEEN 1 AND 5),
  tags JSONB NOT NULL DEFAULT '[]', comment TEXT,
  auto_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- messaging, notifications, orgs, audit ----------
CREATE TABLE IF NOT EXISTS messaging.conversation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT, kind TEXT NOT NULL DEFAULT 'job',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messaging.message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES messaging.conversation(id),
  job_id TEXT, sender TEXT NOT NULL, body TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notification.notification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id TEXT NOT NULL, channel TEXT NOT NULL,
  template TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  sent_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS support.ticket (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES identity.users(id),
  job_id TEXT, reason TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open', assigned_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support.ticket_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES support.ticket(id),
  sender TEXT NOT NULL, body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS b2b.organisation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL, type TEXT NOT NULL,
  billing_profile JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS b2b.organisation_user (
  organisation_id UUID NOT NULL REFERENCES b2b.organisation(id),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  role TEXT NOT NULL, PRIMARY KEY (organisation_id, user_id)
);
CREATE TABLE IF NOT EXISTS b2b.work_order (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES b2b.organisation(id),
  property_id UUID, title TEXT NOT NULL,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  status TEXT NOT NULL DEFAULT 'pending_approval',
  approvals JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS b2b.invoice (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES b2b.organisation(id),
  work_order_id UUID NOT NULL REFERENCES b2b.work_order(id),
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  status TEXT NOT NULL DEFAULT 'issued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit.log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor TEXT NOT NULL, action TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT,
  before JSONB, after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS configuration.flag (
  key TEXT PRIMARY KEY, value BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
