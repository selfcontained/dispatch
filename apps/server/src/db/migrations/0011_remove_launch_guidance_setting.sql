-- Launches now use one complete ruleset, independent of plugin installation.
DELETE FROM settings WHERE key = 'trimmed_launch_guidance_enabled';
