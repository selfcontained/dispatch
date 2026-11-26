/** Decode the workload's command output as the enrolled executor returns it. */
export function commandOutput(chunks: Buffer[], limit: number | null) {
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (limit === null || Buffer.byteLength(text) <= limit)
    return { text, truncated: false };
  return {
    text: new TextDecoder().decode(Buffer.from(text).subarray(0, limit), {
      stream: true,
    }),
    truncated: true,
  };
}
