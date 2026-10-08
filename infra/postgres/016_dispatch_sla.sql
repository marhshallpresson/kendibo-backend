-- Add SLA expiry to dispatch assignments (offers)
ALTER TABLE dispatch.assignment
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Create index for efficient expiry sweeps
CREATE INDEX IF NOT EXISTS idx_assignment_expires_at
  ON dispatch.assignment (expires_at) WHERE status = 'offered';
