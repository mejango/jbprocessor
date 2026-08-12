-- Per-project rolling card-volume cap, in USD cents per 7 days. NULL means
-- the WEEKLY_CARD_CAP_USD_CENTS env default applies. This is the eligibility
-- gate's mechanical backstop: it bounds how much stolen-card volume a single
-- approved project can absorb per dispute cycle, so a bad approval (or a
-- project that turns) is a capped loss, not an unbounded one.
ALTER TABLE projects ADD COLUMN weekly_card_cap_usd_cents bigint;
CREATE INDEX payments_project_recent ON payments (project_id, created_at);
