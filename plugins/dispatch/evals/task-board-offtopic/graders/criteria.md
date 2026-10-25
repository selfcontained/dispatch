Grade whether the agent keeps the `tasks` skill scoped to task-board work.

**Pass criteria:**

1. It handles the ordinary README correction and verification in the repo.
2. It does not load the `tasks` skill or call any `task_*` tool.
3. It does not create a board task, assign itself, or move an existing task merely
   because the request is described as work.

**Fail if:** it treats the ordinary coding request as a reason to inspect or
change the board, even if the README edit is also completed.

Score 1.0 when all three criteria hold, 0.0 when any board operation or skill
load is attempted.
