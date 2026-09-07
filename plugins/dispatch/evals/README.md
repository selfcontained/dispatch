# Evals

Ablation cases for the discovery skills — the ones whose whole job is to make an
agent aware that a Dispatch capability exists.

```bash
claude plugin eval dispatch@dispatch --ablation with-without
```

`--ablation with-without` runs a **no-plugin baseline arm** alongside the
with-plugin arm and reports the score delta. That delta is the number that
matters here. A skill whose description is too narrow shows no delta because it
never fires; one that is too broad shows always-on cost with no delta either.
Both failures are invisible without the baseline arm.

## Status: authored, not yet executed

`claude plugin eval` is in early access and refuses to run on the CLI these were
written against (`2.1.231`) — every invocation returns
`` `plugin eval` is currently in early access `` and exits without running
anything. The cases below follow the documented bare-template layout
(`prompt.md` + `graders/criteria.md`), but **no case here has been executed and
no score has been observed.** Treat the criteria as a first draft to be tuned
once the runner is available, not as a passing suite.

## Cases

| Case                | Skill under test | The failure it is aimed at                                                 |
| ------------------- | ---------------- | -------------------------------------------------------------------------- |
| `share-screenshot`  | `sharing`        | Writing an artifact to disk and pasting the path instead of sharing it     |
| `remember-decision` | `brain`          | Recording durable context in chat, where the next agent cannot find it     |
| `delegate-work`     | `subagents`      | Doing independent parallelizable work serially in one session              |
| `repo-script-tool`  | `repo-tools`     | Re-teaching each agent a shell command instead of publishing it as a tool  |
| `present-decision`  | `surfaces`       | Reducing structured options and feedback to chat or shortcut pins          |
| `route-the-ask`     | `communicate`    | Handing back artifacts, a URL, and a blocking choice as one block of prose |

`sharing` is the sharpest test in the set: the rule it encodes already exists in
two always-on places in Dispatch (launch guidance and repo instructions) and
still gets ignored, so a measurable delta there is evidence that arriving at the
moment of action beats more background text.
