import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function proveFileTransfer(
  text,
  blocks,
  session,
  Client,
  Transport,
  nativeTempRoot
) {
  const image = blocks.find((block) => block.type === "image");
  const reference = /- file: (.+) \(image\/png,/.exec(text)?.[1];
  if (!reference || !image)
    throw new Error("Missing prompt image or file reference");
  const input = await readFile(
    reference.replace("$DISPATCH_FILES_DIR", process.env.DISPATCH_FILES_DIR)
  );
  if (!input.equals(Buffer.from(image.data, "base64")))
    throw new Error("Image and on-machine file differ");

  const endpoint = session.mcpServers.find(
    (entry) => "url" in entry && "headers" in entry
  );
  if (!endpoint) throw new Error("Missing Dispatch MCP endpoint");
  const client = new Client({ name: "file-transfer-fixture", version: "1" });
  await client.connect(
    new Transport(new URL(endpoint.url), {
      requestInit: {
        headers: Object.fromEntries(
          endpoint.headers.map(({ name, value }) => [name, value])
        ),
      },
    })
  );
  let temporary;
  try {
    if (nativeTempRoot)
      temporary = await mkdtemp(
        path.join(nativeTempRoot, "dispatch-transfer-output-")
      );
    const output = path.join(
      temporary ?? process.env.DISPATCH_FILES_DIR,
      "transfer-output.png"
    );
    await writeFile(output, input);
    const post = await client.callTool({
      name: "post",
      arguments: {
        text: "Read the uploaded image and posted the result.",
        attachments: [{ type: "file", path: output }],
      },
    });
    if (post.isError) throw new Error(JSON.stringify(post.content));
  } finally {
    await client.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
