export type BuildIdentity = { version: string; revision: string | null };

export function isBuildIdentity(value: unknown): value is BuildIdentity {
  if (!value || typeof value !== "object") return false;
  const { version, revision } = value as Partial<BuildIdentity>;
  return (
    typeof version === "string" &&
    /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(version) &&
    (revision === null ||
      (typeof revision === "string" && /^[a-f0-9]{40}$/.test(revision)))
  );
}

export function isHostInstanceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value
    )
  );
}
