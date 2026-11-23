async function inBatches(items, size, work) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let item = queue.shift(); item; item = queue.shift())
        await work(item);
    })
  );
}

export async function scheduleScenarios(scenarios, jobs, run) {
  // Keep startup contention away from scenarios that observe short Git probes.
  for (const scenario of scenarios.filter((scenario) => scenario.serial))
    await run(scenario);

  const parallel = scenarios.filter((scenario) => !scenario.serial);
  // A scenario that only waits for a real timeout has a lane of its own.
  await Promise.all([
    inBatches(
      parallel.filter((scenario) => !scenario.waits),
      jobs,
      run
    ),
    ...parallel.filter((scenario) => scenario.waits).map(run),
  ]);
}
