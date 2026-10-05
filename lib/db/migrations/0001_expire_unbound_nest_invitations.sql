BEGIN;

-- Existing invitations had only a household ID. They cannot be safely assigned
-- once a household can contain multiple profiles of the same role.
UPDATE nest_invitations
SET used_at = COALESCE(used_at, now())
WHERE member_id IS NULL AND used_at IS NULL;

COMMIT;