\set ON_ERROR_STOP on

DELETE FROM media_seen;
DELETE FROM media;
DELETE FROM agent_events;
DELETE FROM agent_feedback;
DELETE FROM persona_reviews;
DELETE FROM agents;

INSERT INTO agents (
  id,
  name,
  type,
  status,
  cwd,
  worktree_path,
  worktree_branch,
  tmux_session,
  media_dir,
  codex_args,
  full_access,
  base_branch,
  latest_event_type,
  latest_event_message,
  latest_event_updated_at,
  git_context,
  git_context_stale,
  persona,
  parent_agent_id,
  created_at,
  updated_at
)
VALUES
  (
    'agt_parent_review_open',
    'web notification ack flow',
    'claude',
    'running',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-5db31c172472-agent-172472',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-5db31c172472-agent-172472',
    'agt_5db31c172472/agent-172472',
    'dispatch-open-review',
    NULL,
    '[]'::jsonb,
    true,
    'main',
    'done',
    'Added 5 E2E tests for notification ack flow',
    NOW() - INTERVAL '2 minutes',
    jsonb_build_object(
      'repoRoot', '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-5db31c172472-agent-172472',
      'branch', 'agt_5db31c172472/agent-172472',
      'worktreePath', '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-5db31c172472-agent-172472',
      'worktreeName', 'agt-5db31c172472-agent-172472',
      'isWorktree', true
    ),
    false,
    NULL,
    NULL,
    NOW() - INTERVAL '40 minutes',
    NOW() - INTERVAL '2 minutes'
  ),
  (
    'agt_parent_review_resolved',
    'agent detail IA pass with extra-long realistic naming',
    'codex',
    'running',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-resolved-review',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-resolved-review',
    'agt_release/agent-6f1441',
    'dispatch-resolved-review',
    NULL,
    '[]'::jsonb,
    false,
    'release/0.14',
    'done',
    'Resolved the last review note and updated the design spec doc',
    NOW() - INTERVAL '9 minutes',
    jsonb_build_object(
      'repoRoot', '/Users/brad/dev/apps/dispatch',
      'branch', 'agt_release/agent-6f1441',
      'worktreePath', '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-resolved-review',
      'worktreeName', 'agt-resolved-review',
      'isWorktree', true
    ),
    false,
    NULL,
    NULL,
    NOW() - INTERVAL '80 minutes',
    NOW() - INTERVAL '9 minutes'
  ),
  (
    'agt_parent_running',
    'design-lab-v2 prototype surface',
    'codex',
    'running',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-design-lab',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-design-lab',
    'agt_91d1e714/design-lab-v2',
    'dispatch-design-lab',
    NULL,
    '[]'::jsonb,
    true,
    'main',
    'working',
    'Implementing sidebar-only variation surface in the design lab',
    NOW() - INTERVAL '20 seconds',
    jsonb_build_object(
      'repoRoot', '/Users/brad/dev/apps/dispatch',
      'branch', 'agt_91d1e714/design-lab-v2',
      'worktreePath', '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-design-lab',
      'worktreeName', 'agt-design-lab',
      'isWorktree', true
    ),
    false,
    NULL,
    NULL,
    NOW() - INTERVAL '20 minutes',
    NOW() - INTERVAL '20 seconds'
  ),
  (
    'agt_parent_paused',
    'migration follow-up cleanup',
    'claude',
    'stopped',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-db-fix',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-db-fix',
    'agt_71de23aa/db-fix',
    'dispatch-db-fix',
    NULL,
    '[]'::jsonb,
    true,
    'main',
    'waiting_user',
    'Paused after hitting a failing migration locally',
    NOW() - INTERVAL '14 minutes',
    jsonb_build_object(
      'repoRoot', '/Users/brad/dev/apps/dispatch',
      'branch', 'agt_71de23aa/db-fix',
      'worktreePath', '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-db-fix',
      'worktreeName', 'agt-db-fix',
      'isWorktree', true
    ),
    false,
    NULL,
    NULL,
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '14 minutes'
  ),
  (
    'agt_child_architecture',
    'architecture-review',
    'codex',
    'running',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-5db31c172472-agent-172472',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-5db31c172472-agent-172472',
    'agt_5db31c172472/agent-172472',
    'dispatch-review-arch',
    NULL,
    '[]'::jsonb,
    false,
    'main',
    'done',
    'Approved with a couple of follow-up cleanup items.',
    NOW() - INTERVAL '6 minutes',
    jsonb_build_object(
      'repoRoot', '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-5db31c172472-agent-172472',
      'branch', 'agt_5db31c172472/agent-172472',
      'worktreePath', '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-5db31c172472-agent-172472',
      'worktreeName', 'agt-5db31c172472-agent-172472',
      'isWorktree', true
    ),
    false,
    'architecture-review',
    'agt_parent_review_open',
    NOW() - INTERVAL '30 minutes',
    NOW() - INTERVAL '6 minutes'
  ),
  (
    'agt_child_ux',
    'frontend-ux-review',
    'claude',
    'running',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-resolved-review',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-resolved-review',
    'agt_release/agent-6f1441',
    'dispatch-review-ux',
    NULL,
    '[]'::jsonb,
    false,
    'release/0.14',
    'done',
    'Interaction details look good after the second pass.',
    NOW() - INTERVAL '11 minutes',
    jsonb_build_object(
      'repoRoot', '/Users/brad/dev/apps/dispatch',
      'branch', 'agt_release/agent-6f1441',
      'worktreePath', '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-resolved-review',
      'worktreeName', 'agt-resolved-review',
      'isWorktree', true
    ),
    false,
    'frontend-ux-review',
    'agt_parent_review_resolved',
    NOW() - INTERVAL '55 minutes',
    NOW() - INTERVAL '11 minutes'
  ),
  (
    'agt_child_product',
    'product-review',
    'codex',
    'running',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-resolved-review',
    '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-resolved-review',
    'agt_release/agent-6f1441',
    'dispatch-review-product',
    NULL,
    '[]'::jsonb,
    false,
    'release/0.14',
    'done',
    'Scope looks appropriate and the information hierarchy is clearer.',
    NOW() - INTERVAL '10 minutes',
    jsonb_build_object(
      'repoRoot', '/Users/brad/dev/apps/dispatch',
      'branch', 'agt_release/agent-6f1441',
      'worktreePath', '/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-resolved-review',
      'worktreeName', 'agt-resolved-review',
      'isWorktree', true
    ),
    false,
    'product-review',
    'agt_parent_review_resolved',
    NOW() - INTERVAL '50 minutes',
    NOW() - INTERVAL '10 minutes'
  );

INSERT INTO persona_reviews (
  agent_id,
  parent_agent_id,
  persona,
  status,
  message,
  verdict,
  summary,
  files_reviewed,
  created_at,
  updated_at
)
VALUES
  (
    'agt_child_architecture',
    'agt_parent_review_open',
    'architecture-review',
    'complete',
    'Approved with a couple of follow-up cleanup items.',
    'approve',
    'Approved, but two issues still need attention before closing the loop.',
    '["apps/server/src/server.ts","apps/server/src/slack.ts"]'::jsonb,
    NOW() - INTERVAL '12 minutes',
    NOW() - INTERVAL '6 minutes'
  ),
  (
    'agt_child_ux',
    'agt_parent_review_resolved',
    'frontend-ux-review',
    'complete',
    'Interaction details look good after the second pass.',
    'approve',
    'Interaction details look good after the second pass.',
    '["apps/web/src/components/app/agent-card.tsx","apps/web/src/components/app/feedback-panel.tsx"]'::jsonb,
    NOW() - INTERVAL '20 minutes',
    NOW() - INTERVAL '11 minutes'
  ),
  (
    'agt_child_product',
    'agt_parent_review_resolved',
    'product-review',
    'complete',
    'Scope looks appropriate and the information hierarchy is clearer.',
    'approve',
    'Scope looks appropriate and the information hierarchy is clearer.',
    '["apps/web/src/components/app/design-lab.tsx"]'::jsonb,
    NOW() - INTERVAL '20 minutes',
    NOW() - INTERVAL '10 minutes'
  );

INSERT INTO agent_feedback (
  agent_id,
  severity,
  file_path,
  line_number,
  description,
  suggestion,
  status,
  created_at
)
VALUES
  (
    'agt_child_architecture',
    'high',
    'apps/server/src/server.ts',
    117,
    'pendingWebNotification state can linger after reconnect.',
    'Reset the pending state after a successful ack and refresh the latest event summary.',
    'open',
    NOW() - INTERVAL '8 minutes'
  ),
  (
    'agt_child_architecture',
    'medium',
    'apps/server/src/slack.ts',
    150,
    'Ack retry path should emit one terminal-facing event.',
    'Collapse duplicate notices into one summary update so the sidebar reads more cleanly.',
    'open',
    NOW() - INTERVAL '7 minutes'
  ),
  (
    'agt_child_architecture',
    'low',
    'apps/server/src/server.ts',
    128,
    'Latest-event text can drift from the SSE event source.',
    'Use one shared formatter for sidebar and stream updates.',
    'ignored',
    NOW() - INTERVAL '7 minutes'
  ),
  (
    'agt_child_architecture',
    'low',
    'apps/server/src/server.ts',
    1071,
    'Issue summary should mention delivery channel.',
    'Include the notification destination in the summary copy.',
    'fixed',
    NOW() - INTERVAL '7 minutes'
  ),
  (
    'agt_child_ux',
    'low',
    'apps/web/src/components/app/agent-card.tsx',
    42,
    'Name clipping eased after moving destructive actions.',
    'Keep low-frequency controls out of the collapsed row.',
    'fixed',
    NOW() - INTERVAL '12 minutes'
  ),
  (
    'agt_child_ux',
    'low',
    'apps/web/src/components/app/feedback-panel.tsx',
    201,
    'Badge hierarchy now matches review urgency.',
    'Continue to de-emphasize resolved items.',
    'fixed',
    NOW() - INTERVAL '12 minutes'
  ),
  (
    'agt_child_ux',
    'low',
    'apps/web/src/components/app/design-lab.tsx',
    88,
    'Prototype controls mirror actual interaction model.',
    'Keep the sidebar prototype close to real component structure.',
    'ignored',
    NOW() - INTERVAL '12 minutes'
  ),
  (
    'agt_child_product',
    'low',
    'apps/web/src/components/app/design-lab.tsx',
    120,
    'Mode naming is clearer than before.',
    'Keep the labels stable while iterating on the visuals.',
    'fixed',
    NOW() - INTERVAL '11 minutes'
  );
