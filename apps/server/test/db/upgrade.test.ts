/**
 * Upgrade integration test.
 *
 * Dynamically tests that the latest migration doesn't break existing data:
 * 1. Runs all migrations except the last one
 * 2. Seeds representative data across all tables
 * 3. Applies the final migration
 * 4. Verifies all seeded data survives and is queryable
 *
 * When there's only one migration (the baseline), the test is skipped
 * since there's no upgrade path to test yet.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";

import { runMigrations } from "../../src/db/migrate.js";
import { setupTestDb, teardownTestDb, getTestDatabaseUrl } from "./setup.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations"
);
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql") || f.endsWith(".ts") || f.endsWith(".js"))
  .sort();

const hasMigrationsToTest = migrationFiles.length > 1;

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

describe.skipIf(!hasMigrationsToTest)(
  "upgrade: applying latest migration preserves existing data",
  () => {
    it("should apply all migrations except the last", async () => {
      const countBeforeLast = migrationFiles.length - 1;

      await runMigrations({
        databaseUrl: getTestDatabaseUrl(),
        count: countBeforeLast,
      });

      // Verify the last migration has NOT been applied
      const applied = await pool.query(
        `SELECT name FROM pgmigrations ORDER BY run_on`
      );
      const appliedNames = applied.rows.map((r: { name: string }) => r.name);
      expect(appliedNames).toHaveLength(countBeforeLast);

      const lastMigrationName = migrationFiles[
        migrationFiles.length - 1
      ].replace(/\.[^.]+$/, "");
      expect(appliedNames).not.toContain(lastMigrationName);
    });

    it("should seed representative data", async () => {
      await pool.query(`
      INSERT INTO agents (id, name, type, status, cwd, full_access, codex_args, pins)
      VALUES
        ('agent-1', 'My Agent', 'claude-code', 'running', '/home/user/project', true,
         '["--model", "opus"]'::jsonb,
         '[{"label":"API","value":"http://localhost:3000","type":"url"}]'::jsonb),
        ('agent-2', 'Helper', 'codex', 'stopped', '/tmp/work', false, '[]'::jsonb, '[]'::jsonb),
        ('agent-3', 'Security Reviewer', 'codex', 'stopped', '/tmp/work', false, '[]'::jsonb, '[]'::jsonb),
        ('agent-4', 'Clean Reviewer', 'codex', 'stopped', '/tmp/work', false, '[]'::jsonb, '[]'::jsonb),
        ('agent-5', 'Resolved Reviewer', 'codex', 'stopped', '/tmp/work', false, '[]'::jsonb, '[]'::jsonb),
        ('agent-6', 'Already Migrated Reviewer', 'codex', 'stopped', '/tmp/work', false, '[]'::jsonb, '[]'::jsonb),
        ('agent-7', 'Active Reviewer', 'codex', 'running', '/tmp/work', false, '[]'::jsonb, '[]'::jsonb),
        ('agent-8', 'Cancelled Reviewer', 'codex', 'stopped', '/tmp/work', false, '[]'::jsonb, '[]'::jsonb)
    `);

      await pool.query(`
      UPDATE agents
      SET persona = CASE id
            WHEN 'agent-3' THEN 'security-review'
            WHEN 'agent-4' THEN 'architecture-review'
            WHEN 'agent-5' THEN 'infra-review'
            WHEN 'agent-6' THEN 'product-review'
            WHEN 'agent-7' THEN 'frontend-ux-review'
            WHEN 'agent-8' THEN 'release-readiness-review'
          END,
          parent_agent_id = 'agent-1'
      WHERE id IN ('agent-3', 'agent-4', 'agent-5', 'agent-6', 'agent-7', 'agent-8')
    `);

      await pool.query(`
      INSERT INTO persona_reviews
        (agent_id, parent_agent_id, persona, status, verdict, summary)
      VALUES
        ('agent-3', 'agent-1', 'security-review', 'complete', 'request_changes', 'One security concern.'),
        ('agent-4', 'agent-1', 'architecture-review', 'complete', 'approve', 'Architecture is sound.'),
        ('agent-5', 'agent-1', 'infra-review', 'awaiting_recheck', 'request_changes', '   '),
        ('agent-6', 'agent-1', 'product-review', 'complete', 'request_changes', 'Legacy duplicate must be skipped.'),
        ('agent-7', 'agent-1', 'frontend-ux-review', 'reviewing', NULL, NULL),
        ('agent-8', 'agent-1', 'release-readiness-review', 'cancelled', NULL, NULL)
    `);

      await pool.query(`
      INSERT INTO reviews
        (agent_id, assigned_agent_id, reviewer_type, reviewer_agent_id, summary, status)
      VALUES
        ('agent-1', 'agent-1', 'agent', 'agent-6', 'Existing unified review.', 'open')
    `);

      await pool.query(`
      INSERT INTO media (agent_id, file_name, source, size_bytes, description)
      VALUES
        ('agent-1', 'screenshot-001.png', 'screenshot', 204800, 'Login page'),
        ('agent-1', 'screenshot-002.png', 'screenshot', 102400, NULL),
        ('agent-2', 'output.png', 'screenshot', 51200, 'Final result')
    `);

      await pool.query(`
      INSERT INTO media_seen (agent_id, media_key)
      VALUES ('agent-1', 'screenshot-001.png')
    `);

      await pool.query(`
      INSERT INTO settings (key, value) VALUES ('worktreeLocation', 'sibling')
    `);

      await pool.query(`
      INSERT INTO sessions (token, expires_at)
      VALUES ('test-session-token', NOW() + INTERVAL '24 hours')
    `);

      await pool.query(`
      INSERT INTO agent_events (agent_id, event_type, message, metadata, agent_type, agent_name, project_dir)
      VALUES
        ('agent-1', 'working', 'Reading files', '{"phase":"research"}'::jsonb, 'claude-code', 'My Agent', '/home/user/project'),
        ('agent-1', 'done', 'Task complete', '{}'::jsonb, 'claude-code', 'My Agent', '/home/user/project')
    `);

      await pool.query(`
      INSERT INTO agent_token_usage (agent_id, session_id, model, input_tokens, output_tokens, cache_read_tokens, message_count, session_start)
      VALUES ('agent-1', 'sess-abc', 'claude-opus-4-6', 15000, 3000, 5000, 12, NOW() - INTERVAL '1 hour')
    `);

      await pool.query(`
      INSERT INTO agent_feedback (
        agent_id, severity, file_path, line_number, description, suggestion,
        status, resolution_reason, resolved_at
      )
      VALUES
        ('agent-1', 'warning', 'src/index.ts', 42, 'Unused import', 'Remove the import', 'open', NULL, NULL),
        ('agent-3', 'high', 'src/auth.ts', 12, 'Missing authorization check', 'Validate ownership', 'open', NULL, NULL),
        ('agent-3', 'medium', 'src/session.ts', 18, 'Forwarded concern', NULL, 'forwarded', NULL, NULL),
        ('agent-3', 'low', 'src/cache.ts', 24, 'Fixed concern', 'Use the shared cache.', 'fixed', 'Implemented shared cache.', NOW() - INTERVAL '3 minutes'),
        ('agent-3', 'info', 'src/log.ts', 30, 'Ignored concern', '   ', 'ignored', 'Not applicable here.', NOW() - INTERVAL '2 minutes'),
        ('agent-3', 'info', 'src/old.ts', 36, 'Dismissed concern', NULL, 'dismissed', NULL, NOW() - INTERVAL '1 minute'),
        ('agent-5', 'high', 'infra/deploy.ts', 5, 'Resolved deploy concern', NULL, 'fixed', NULL, NOW() - INTERVAL '3 minutes'),
        ('agent-5', 'medium', NULL, NULL, 'Resolved general concern', NULL, 'ignored', 'Accepted risk.', NOW() - INTERVAL '2 minutes'),
        ('agent-5', 'low', 'infra/old.ts', 9, 'Dismissed deploy concern', NULL, 'dismissed', 'Obsolete path.', NOW() - INTERVAL '1 minute'),
        ('agent-6', 'medium', 'src/duplicate.ts', 7, 'Must not duplicate', NULL, 'open', NULL, NULL),
        ('agent-7', 'medium', 'src/in-progress.ts', 11, 'Still being reviewed', NULL, 'open', NULL, NULL)
    `);

      await pool.query(`
      INSERT INTO simulator_reservations (udid, agent_id, status)
      VALUES ('UDID-1234', 'agent-1', 'reserved')
    `);
    });

    it("should apply the latest migration without errors", async () => {
      // Run remaining migrations (just the last one)
      await runMigrations(getTestDatabaseUrl());

      // All migrations should now be applied
      const applied = await pool.query(
        `SELECT name FROM pgmigrations ORDER BY run_on`
      );
      expect(applied.rows).toHaveLength(migrationFiles.length);
    });

    it("should preserve agents with all fields intact", async () => {
      const agents = await pool.query(`SELECT * FROM agents ORDER BY id`);
      expect(agents.rowCount).toBe(8);

      const agent1 = agents.rows[0];
      expect(agent1.id).toBe("agent-1");
      expect(agent1.name).toBe("My Agent");
      expect(agent1.type).toBe("claude-code");
      expect(agent1.status).toBe("running");
      expect(agent1.full_access).toBe(true);
      expect(agent1.codex_args).toEqual(["--model", "opus"]);
      expect(agent1.pins).toEqual([
        { label: "API", value: "http://localhost:3000", type: "url" },
      ]);

      const agent2 = agents.rows[1];
      expect(agent2.id).toBe("agent-2");
      expect(agent2.type).toBe("codex");
      expect(agent2.status).toBe("stopped");

      expect(
        agents.rows.slice(2).map((agent: { role: string }) => agent.role)
      ).toEqual(Array(6).fill("review"));
    });

    it("should migrate legacy review states, summaries, and clean approvals", async () => {
      const reviews = await pool.query(
        `SELECT reviewer_agent_id, summary, status
         FROM reviews
         WHERE reviewer_agent_id IN ('agent-3', 'agent-4', 'agent-5', 'agent-6', 'agent-7', 'agent-8')
         ORDER BY reviewer_agent_id`
      );
      expect(reviews.rows).toEqual([
        {
          reviewer_agent_id: "agent-3",
          summary: "One security concern.",
          status: "partially_resolved",
        },
        {
          reviewer_agent_id: "agent-4",
          summary: "Architecture is sound.",
          status: "resolved",
        },
        {
          reviewer_agent_id: "agent-5",
          summary: "Legacy persona review by infra-review",
          status: "resolved",
        },
        {
          reviewer_agent_id: "agent-6",
          summary: "Existing unified review.",
          status: "open",
        },
      ]);
    });

    it("should migrate every legacy feedback state and its thread history", async () => {
      const feedback = await pool.query(
        `SELECT fi.file_path, fi.line_start, fi.line_end, fi.status,
                fi.resolution, fi.resolution_note, fi.resolved_by,
                fi.resolved_at, m.content->>'body' AS body
         FROM review_feedback_items fi
         JOIN reviews r ON r.id = fi.review_id
         JOIN review_thread_messages m ON m.feedback_item_id = fi.id
         WHERE r.reviewer_agent_id = 'agent-3' AND m.type = 'text'
         ORDER BY fi.id`
      );
      expect(feedback.rows).toHaveLength(5);
      expect(
        feedback.rows.map(
          ({ resolved_at: _resolvedAt, ...item }: { resolved_at: Date }) => item
        )
      ).toEqual([
        {
          file_path: "src/auth.ts",
          line_start: 12,
          line_end: null,
          status: "open",
          resolution: null,
          resolution_note: null,
          resolved_by: null,
          body: "Missing authorization check\n\nSuggestion: Validate ownership",
        },
        {
          file_path: "src/session.ts",
          line_start: 18,
          line_end: null,
          status: "open",
          resolution: null,
          resolution_note: null,
          resolved_by: null,
          body: "Forwarded concern",
        },
        {
          file_path: "src/cache.ts",
          line_start: 24,
          line_end: null,
          status: "resolved",
          resolution: "fixed",
          resolution_note: "Implemented shared cache.",
          resolved_by: "agent-1",
          body: "Fixed concern\n\nSuggestion: Use the shared cache.",
        },
        {
          file_path: "src/log.ts",
          line_start: 30,
          line_end: null,
          status: "resolved",
          resolution: "dismissed",
          resolution_note: "Not applicable here.",
          resolved_by: "agent-1",
          body: "Ignored concern",
        },
        {
          file_path: "src/old.ts",
          line_start: 36,
          line_end: null,
          status: "resolved",
          resolution: "dismissed",
          resolution_note: null,
          resolved_by: "agent-1",
          body: "Dismissed concern",
        },
      ]);
      expect(feedback.rows.slice(0, 2).every((item) => !item.resolved_at)).toBe(
        true
      );
      expect(feedback.rows.slice(2).every((item) => item.resolved_at)).toBe(
        true
      );

      const messages = await pool.query(
        `SELECT m.type, m.author_agent_id, m.content->>'resolution' AS resolution
         FROM review_thread_messages m
         JOIN review_feedback_items fi ON fi.id = m.feedback_item_id
         JOIN reviews r ON r.id = fi.review_id
         WHERE r.reviewer_agent_id = 'agent-3'
         ORDER BY m.id`
      );
      expect(
        messages.rows.filter((message) => message.type === "text")
      ).toHaveLength(5);
      expect(
        messages.rows
          .filter((message) => message.type === "resolution")
          .map((message) => ({
            author_agent_id: message.author_agent_id,
            resolution: message.resolution,
          }))
      ).toEqual([
        { author_agent_id: "agent-1", resolution: "fixed" },
        { author_agent_id: "agent-1", resolution: "dismissed" },
        { author_agent_id: "agent-1", resolution: "dismissed" },
      ]);
    });

    it("should skip active, cancelled, and already-migrated legacy reviews", async () => {
      const reviewCounts = await pool.query(
        `SELECT reviewer_agent_id, COUNT(*)::int AS count
         FROM reviews
         WHERE reviewer_agent_id IN ('agent-6', 'agent-7', 'agent-8')
         GROUP BY reviewer_agent_id
         ORDER BY reviewer_agent_id`
      );
      expect(reviewCounts.rows).toEqual([
        { reviewer_agent_id: "agent-6", count: 1 },
      ]);

      const existingItems = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM review_feedback_items fi
         JOIN reviews r ON r.id = fi.review_id
         WHERE r.reviewer_agent_id = 'agent-6'`
      );
      expect(existingItems.rows[0].count).toBe(0);
    });

    it("should remain idempotent when the migration SQL is executed again", async () => {
      const before = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM reviews) AS reviews,
           (SELECT COUNT(*)::int FROM review_feedback_items) AS items,
           (SELECT COUNT(*)::int FROM review_thread_messages) AS messages`
      );
      const latestMigrationSql = readFileSync(
        path.join(migrationsDir, migrationFiles[migrationFiles.length - 1]),
        "utf8"
      );

      await pool.query(latestMigrationSql);

      const after = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM reviews) AS reviews,
           (SELECT COUNT(*)::int FROM review_feedback_items) AS items,
           (SELECT COUNT(*)::int FROM review_thread_messages) AS messages`
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it("should preserve media with descriptions", async () => {
      const media = await pool.query(`SELECT * FROM media ORDER BY file_name`);
      expect(media.rowCount).toBe(3);
      expect(media.rows[0].description).toBe("Final result");
      expect(media.rows[1].description).toBe("Login page");
      expect(media.rows[2].description).toBeNull();
    });

    it("should preserve media_seen records", async () => {
      const seen = await pool.query(`SELECT * FROM media_seen`);
      expect(seen.rowCount).toBe(1);
      expect(seen.rows[0].agent_id).toBe("agent-1");
    });

    it("should preserve settings", async () => {
      const settings = await pool.query(
        `SELECT * FROM settings WHERE key = 'worktreeLocation'`
      );
      expect(settings.rowCount).toBe(1);
      expect(settings.rows[0].value).toBe("sibling");
    });

    it("should preserve sessions", async () => {
      const sessions = await pool.query(
        `SELECT * FROM sessions WHERE token = 'test-session-token'`
      );
      expect(sessions.rowCount).toBe(1);
    });

    it("should preserve agent events", async () => {
      const events = await pool.query(`SELECT * FROM agent_events ORDER BY id`);
      expect(events.rowCount).toBe(2);
      expect(events.rows[0].event_type).toBe("working");
      expect(events.rows[0].agent_type).toBe("claude-code");
      expect(events.rows[0].project_dir).toBe("/home/user/project");
    });

    it("should preserve token usage records", async () => {
      const usage = await pool.query(
        `SELECT * FROM agent_token_usage WHERE agent_id = 'agent-1'`
      );
      expect(usage.rowCount).toBe(1);
      expect(usage.rows[0].model).toBe("claude-opus-4-6");
      expect(usage.rows[0].input_tokens).toBe(15000);
      expect(usage.rows[0].output_tokens).toBe(3000);
    });

    it("should preserve feedback records", async () => {
      const feedback = await pool.query(
        `SELECT * FROM agent_feedback WHERE agent_id = 'agent-1'`
      );
      expect(feedback.rowCount).toBe(1);
      expect(feedback.rows[0].severity).toBe("warning");
      expect(feedback.rows[0].line_number).toBe(42);
    });

    it("should preserve simulator reservations", async () => {
      const res = await pool.query(
        `SELECT * FROM simulator_reservations WHERE udid = 'UDID-1234'`
      );
      expect(res.rowCount).toBe(1);
      expect(res.rows[0].agent_id).toBe("agent-1");
    });

    it("should still enforce cascade deletes after upgrade", async () => {
      await pool.query(`DELETE FROM agents WHERE id = 'agent-1'`);

      const media = await pool.query(
        `SELECT * FROM media WHERE agent_id = 'agent-1'`
      );
      const seen = await pool.query(
        `SELECT * FROM media_seen WHERE agent_id = 'agent-1'`
      );
      const feedback = await pool.query(
        `SELECT * FROM agent_feedback WHERE agent_id = 'agent-1'`
      );
      const usage = await pool.query(
        `SELECT * FROM agent_token_usage WHERE agent_id = 'agent-1'`
      );

      expect(media.rowCount).toBe(0);
      expect(seen.rowCount).toBe(0);
      expect(feedback.rowCount).toBe(0);
      expect(usage.rowCount).toBe(0);
    });
  }
);
