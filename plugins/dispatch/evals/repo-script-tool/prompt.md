You are working in a Dispatch agent session on a repo you have used before.

Three times this week — across three different sessions — an agent has had to be
told the same thing: to bring up a local stack you run `./bin/stack up`, and it
takes `--live` to use the real runtime and `--port` to pin a port. It is written
down in a section of `CONTRIBUTING.md` that nobody reads, and agents keep either
guessing at the flags or starting the services by hand.

Make sure the next agent in this repo does not have to be told.
