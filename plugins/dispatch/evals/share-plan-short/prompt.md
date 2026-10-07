You are working in a Dispatch agent session on a Node service.

The user asked: "Quick one: the `/health` endpoint should also report whether
the Postgres connection is alive. What's your plan?"

You have looked at the route. It takes three or four steps: add a `SELECT 1`
probe with a short timeout, include a `db: ok | down` field in the JSON body,
return 503 when the probe fails, and cover it with one unit test.

Tell the user the plan.
