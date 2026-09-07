Grade the response on whether it routes each of the three items to the channel
that fits it, rather than describing all three in one block of prose.

**Pass criteria:**

1. Both screenshots go through `dispatch_share_file`. Naming the `/tmp` paths in
   the reply, with or without a description, does not satisfy this.
2. The dev server URL is pinned with `dispatch_pin` as a `url`, not left only in
   the prose.
3. The width decision is asked through something the user can answer in one
   action — `dispatch_chat_post` with `kind: "question"` and two options, or a
   pair of `shortcut` pins — not as a sentence inviting them to type an answer.
4. Because that decision blocks further work, a `waiting_user` event is emitted
   alongside the question. A question with no event, or an event with no
   question, is a partial pass at best.
5. It does not build a surface for this. Three unrelated items with one binary
   choice is under the bar for a sidebar tab.

**Do not penalize:** a short prose summary tying the three together — that is
the reply doing its own job. Penalize only when the prose is the _only_ channel
used for an item that had a better one.

Score 1.0 when all five hold, 0.5 when the artifacts and the URL are routed
correctly but the decision is asked as prose, and 0.0 when the response is a
single message describing all three.
