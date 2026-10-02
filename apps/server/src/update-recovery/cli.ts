export async function runRecoveryCli(argv: string[]): Promise<void> {
  const { enrollLinux, runLinuxRecovery, serveLinuxRecovery } =
    await import("./linux.js");
  const mode = argv[0];
  const config = argv[1];
  if (!config) throw new Error("Missing recovery configuration");
  if (mode === "recovery-inspect") {
    const path = await import("node:path");
    const { RecoveryStore } = await import("./store.js");
    if (!argv[2]) throw new Error("Missing recovery transaction");
    const store = await RecoveryStore.open(path.dirname(path.resolve(config)));
    console.log(JSON.stringify(await store.read(argv[2]), null, 2));
  } else if (mode === "recovery-enroll")
    await enrollLinux(config, argv[2] === "owned");
  else if (mode === "recovery-serve") await serveLinuxRecovery(config);
  else if (
    mode === "recovery-apply" ||
    mode === "recovery-boot" ||
    mode === "recovery-resume"
  ) {
    if (!argv[2]) throw new Error("Missing recovery transaction");
    await runLinuxRecovery(
      config,
      argv[2],
      mode === "recovery-boot",
      mode === "recovery-resume"
    );
  } else throw new Error("Unknown recovery mode");
}
