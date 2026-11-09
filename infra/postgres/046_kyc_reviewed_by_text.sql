-- Automatic KYC approvals record the reviewer as 'auto:<provider>' (e.g.
-- 'auto:prembly'), but both reviewer columns were UUID, so every automatic
-- approval failed on its final write ("column is of type uuid but expression
-- is of type text"). Admin reviewers' ids are kept as their text form.
ALTER TABLE kyc.customer ALTER COLUMN reviewed_by TYPE TEXT USING reviewed_by::text;
ALTER TABLE provider.provider ALTER COLUMN kyc_reviewed_by TYPE TEXT USING kyc_reviewed_by::text;
