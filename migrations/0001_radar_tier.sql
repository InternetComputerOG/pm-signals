-- Adds the two columns the radar tier needs to an already-deployed database.
--
-- Both come free with discovery: Gamma's market payload already carries
-- endDate and volumeNum, so recording them costs no extra subrequest. They are
-- context rather than inputs - neither feeds the score.
--
--   resolution_date  drives "resolves in 3d" on a card. A market priced at
--                    0.40 the day before it resolves is a different thing from
--                    one priced at 0.40 three weeks out.
--   volume           marks a thin book, so a $10 market does not read as
--                    equivalent to a $900 one now that volume no longer gates
--                    discovery.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS, so this is one-shot and is kept out
-- of schema.sql, which stays idempotent for fresh deploys.
--
--   npx wrangler d1 execute pead-whale --remote --file migrations/0001_radar_tier.sql

ALTER TABLE signal_history ADD COLUMN resolution_date TEXT;
ALTER TABLE signal_history ADD COLUMN volume REAL;
