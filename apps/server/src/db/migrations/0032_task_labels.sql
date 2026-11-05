CREATE TABLE task_labels (
 id text PRIMARY KEY,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
 color text NOT NULL CHECK (color IN ('gray','red','orange','green','blue','purple'))
);
CREATE UNIQUE INDEX task_labels_project_name ON task_labels(project_id, lower(name));
CREATE TABLE task_label_assignments (
 task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 label_id text NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
 PRIMARY KEY(task_id,label_id)
);
