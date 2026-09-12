-- 005-assigned-agent.sql
-- Task → agent-host assignment for multi-machine kanban. Null = unassigned
-- (existing rows stay NULL; no backfill needed — assignment is opt-in).
-- Values match the deck's machines registry id ("local" = the deck's own
-- machine).

ALTER TABLE tasks ADD COLUMN assigned_agent TEXT;
