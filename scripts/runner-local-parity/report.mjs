import { label } from "./ledger.mjs";

const cell = (value) => String(value).replaceAll("|", "\\|");

export function report(run) {
  const passed =
    !run.failures.length && !run.unexpected.length && !run.stale.length;
  const lines = [
    "",
    `# Local parity: ${passed ? "PASS" : "FAIL"}`,
    "",
    `main ${run.main.slice(0, 12)}, head ${run.head.slice(0, 12)}${run.workingTree ? " plus the working tree" : ""}${run.mode === "control" ? " (control: main against main)" : ""}, ${run.seconds}s`,
    "",
    `${run.known.length} known regressions, ${run.intended.length} intended differences, ${run.unexpected.length} unexpected, ${run.stale.length} stale entries, ${run.failures.length} failures.`,
  ];
  if (!run.complete)
    lines.push("", "Partial run: this is not proof of parity.");

  lines.push("", "| Scenario | Head against main |", "| --- | --- |");
  const results = new Map(run.results.map((item) => [item.name, item]));
  const count = (entries, name) =>
    entries.filter((entry) => entry.scenario === name).length;
  for (const { name, skip } of run.scenarios) {
    const result = results.get(name);
    let state;
    if (skip) state = `skipped: ${skip}`;
    else if (!result?.completed) state = "did not complete";
    else
      state =
        [
          [count(run.known, name), "known"],
          [count(run.intended, name), "intended"],
          [count(run.unexpected, name), "UNEXPECTED"],
          [count(run.stale, name), "STALE"],
        ]
          .filter(([total]) => total)
          .map(([total, kind]) => `${total} ${kind}`)
          .join(", ") || "same";
    lines.push(`| ${cell(name)} | ${cell(state)} |`);
  }

  const byFinding = new Map();
  for (const entry of run.known)
    byFinding.set(entry.finding, (byFinding.get(entry.finding) ?? 0) + 1);
  if (byFinding.size) {
    lines.push(
      "",
      "## Known regressions",
      "",
      "| Finding | Entries | Task |",
      "| --- | --- | --- |"
    );
    for (const [id, total] of [...byFinding].sort(([a], [b]) =>
      a.localeCompare(b, "en", { numeric: true })
    ))
      lines.push(
        `| ${id}: ${cell(run.findings[id].title)} | ${total} | ${run.findings[id].task} |`
      );
  }

  const list = (title, entries) => {
    if (!entries.length) return;
    lines.push("", `## ${title}`, "");
    for (const entry of entries)
      lines.push(
        `- ${label(entry)}`,
        `  - main: ${entry.main}`,
        `  - head: ${entry.head}`
      );
  };
  list("Unexpected differences", run.unexpected);
  list(
    "Stale entries (fixed or changed: remove them in the same commit)",
    run.stale
  );
  if (run.failures.length) lines.push("", "## Failures");
  for (const failure of run.failures) {
    lines.push(
      "",
      `### ${failure.scenario} (${failure.side})`,
      "",
      "```",
      failure.error
    );
    if (failure.log) lines.push("--- server log", failure.log);
    lines.push("```");
  }
  return { markdown: `${lines.join("\n")}\n`, passed };
}
