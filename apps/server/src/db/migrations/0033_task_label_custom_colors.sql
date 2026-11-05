ALTER TABLE task_labels DROP CONSTRAINT task_labels_color_check;
ALTER TABLE task_labels ADD CONSTRAINT task_labels_color_check CHECK (color IN ('gray','red','orange','green','blue','purple') OR color ~ '^#[0-9a-fA-F]{6}$');
