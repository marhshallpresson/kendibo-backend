-- 037: price proposal + one counter-offer (inDrive pattern), booking reminders,
-- check-in distance (fresh provider location), new-device payout hold, pro
-- check-in selfie, and two-way ratings hidden until both sides rate.
ALTER TABLE booking.service_request ADD COLUMN IF NOT EXISTS proposed_kobo BIGINT;
ALTER TABLE booking.service_request ADD COLUMN IF NOT EXISTS agreed_kobo BIGINT;
ALTER TABLE booking.request_offer ADD COLUMN IF NOT EXISTS counter_kobo BIGINT;
ALTER TABLE booking.request_offer ADD COLUMN IF NOT EXISTS countered_at TIMESTAMPTZ;
ALTER TABLE booking.booking ADD COLUMN IF NOT EXISTS reminder_24h_at TIMESTAMPTZ;
ALTER TABLE booking.booking ADD COLUMN IF NOT EXISTS reminder_1h_at TIMESTAMPTZ;
ALTER TABLE booking.booking ADD COLUMN IF NOT EXISTS checkin_selfie_asset TEXT;
ALTER TABLE booking.booking ADD COLUMN IF NOT EXISTS checkin_selfie_ok BOOLEAN;
ALTER TABLE booking.booking ADD COLUMN IF NOT EXISTS job_lat DOUBLE PRECISION;
ALTER TABLE booking.booking ADD COLUMN IF NOT EXISTS job_lng DOUBLE PRECISION;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS location_at TIMESTAMPTZ;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS new_device_at TIMESTAMPTZ;
CREATE SCHEMA IF NOT EXISTS review;
CREATE TABLE IF NOT EXISTS review.party_rating (
  booking_id UUID NOT NULL,
  rater_role TEXT NOT NULL CHECK (rater_role IN ('customer', 'provider')),
  rater_id UUID NOT NULL,
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, rater_role)
);
