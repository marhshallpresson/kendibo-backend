-- 018_service_request_category.sql — persist the chosen catalog category on an
-- on-demand service request. The customer app picks a category (not a concrete
-- service), so an accepted request needs the category to resolve a default
-- fixed-price service and mint a booking. Idempotent (safe to re-run).
ALTER TABLE booking.service_request ADD COLUMN IF NOT EXISTS category_id TEXT;
