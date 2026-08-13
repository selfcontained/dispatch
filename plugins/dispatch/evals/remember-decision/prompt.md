You are working in a Dispatch agent session on a service repo.

After a long investigation you and the user settled a design question: the
service will keep using optimistic concurrency on the `orders` table rather than
switching to row-level locks, because the contention measured under load was
lower than the lock overhead. Two alternatives were explicitly rejected —
advisory locks and a serialized write queue.

Other agents will work on this repo over the next few weeks and some of them will
reach the same fork in the road.

Make sure this decision is available to them.
