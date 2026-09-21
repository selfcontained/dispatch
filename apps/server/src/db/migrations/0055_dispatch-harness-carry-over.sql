-- Carry a prerelease install's harness opt-in onto the flag that replaced it.
--
-- On v0.38.13-harness.2 and .3 the Dispatch Harness was turned on by adding
-- `dispatch` to the `enabled_agent_types` setting. It is now its own flag,
-- `dispatch_harness_enabled`, which defaults to off, and
-- `sanitizeEnabledAgentTypes` strips `dispatch` from the stored list on
-- read. Without this statement an install that had the harness on loses it
-- on update with nothing said: the type disappears from the create dialog,
-- and a *running* dispatch parent's dispatch_launch_persona starts throwing
-- "dispatch agents are disabled in settings" mid-turn, because a persona
-- defaults to its parent's own type.
--
-- ON CONFLICT DO NOTHING so an operator who has already set the new flag
-- either way keeps their choice. No settings row, or a row without
-- `dispatch` in it, means nobody opted in and this is a no-op.
--
-- Known residual: an install whose list was exactly `["dispatch"]` gets the
-- harness back here, but its list still sanitizes to empty and so falls back
-- to the default types. That fallback predates this work and cannot tell
-- "the operator chose only the harness" from "nobody chose".
INSERT INTO settings (key, value, updated_at)
SELECT 'dispatch_harness_enabled', 'true', NOW()
  FROM settings
 WHERE key = 'enabled_agent_types'
   AND value LIKE '%"dispatch"%'
ON CONFLICT (key) DO NOTHING;
