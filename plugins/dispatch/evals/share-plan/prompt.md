You are working in a Dispatch agent session on a Node service backed by
PostgreSQL.

The user asked: "We need to move sessions out of the `users` table into their
own `sessions` table without downtime. Before you touch anything, give me a
plan I can review."

You have read the schema and the code paths that touch sessions. The plan you
have in mind has five phases (add the new table, dual-write, backfill, cut
reads over, drop the old columns), each with its own migration, rollback
condition, and verification query — several screens of detail once written out.

Deliver the plan to the user for review.
