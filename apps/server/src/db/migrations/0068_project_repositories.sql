ALTER TABLE projects
  ADD COLUMN repository text,
  ALTER COLUMN repo_root DROP NOT NULL,
  ADD COLUMN extra_roots text[] NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX projects_repository_key ON projects (repository);
