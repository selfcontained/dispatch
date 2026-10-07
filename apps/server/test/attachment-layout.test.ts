import { describe, expect, it } from "vitest";
import {
  fileMedia,
  layoutAttachments,
  type ChatAttachment,
} from "@dispatch/shared";

import { toBlock, type BlockRow } from "../src/chat/store.js";

function image(fileId: number): ChatAttachment {
  return {
    type: "file",
    fileId,
    fileName: `shot-${fileId}.png`,
    sizeBytes: 1,
    mimeType: "image/png",
    media: "image",
  };
}

const link: ChatAttachment = { type: "link", url: "https://example.com" };
const pdf: ChatAttachment = {
  type: "file",
  fileId: 99,
  fileName: "report.pdf",
  sizeBytes: 1,
  mimeType: "application/pdf",
  media: "pdf",
};

describe("fileMedia", () => {
  it("reads a file's media off its MIME type", () => {
    expect(fileMedia("image/png")).toBe("image");
    expect(fileMedia("video/mp4")).toBe("video");
    expect(fileMedia("application/pdf")).toBe("pdf");
    expect(fileMedia("text/markdown")).toBe("text");
    expect(fileMedia("application/json")).toBe("text");
    expect(fileMedia("application/octet-stream")).toBe("file");
    expect(fileMedia(undefined)).toBe("file");
  });
});

describe("layoutAttachments", () => {
  it("leaves a lone image, and everything else, on its own", () => {
    expect(layoutAttachments([link, image(1), pdf])).toEqual([
      { kind: "single", attachment: link },
      { kind: "single", attachment: image(1) },
      { kind: "single", attachment: pdf },
    ]);
  });

  it("gathers every image into one gallery where the first one was", () => {
    expect(
      layoutAttachments([link, image(1), pdf, image(2), image(3)])
    ).toEqual([
      { kind: "single", attachment: link },
      { kind: "gallery", images: [image(1), image(2), image(3)] },
      { kind: "single", attachment: pdf },
    ]);
  });

  it("goes by media, not by a name that looks like an image", () => {
    const named = { ...pdf, fileName: "looks.png" };
    expect(layoutAttachments([image(1), named])).toEqual([
      { kind: "single", attachment: image(1) },
      { kind: "single", attachment: named },
    ]);
  });
});

describe("toBlock", () => {
  it("derives media from the attachment's MIME type, never its name", () => {
    const now = new Date();
    const row: BlockRow = {
      id: "b1",
      stream_id: "s1",
      author_kind: "agent",
      author_agent_id: "agt_1",
      to_agent_id: null,
      kind: "text",
      thread_id: null,
      reply_to: null,
      text: "",
      data: null,
      state: null,
      attachments: [
        // No type recorded: a name that looks like an image does not make it one.
        { type: "file", fileId: 1, fileName: "a.png", sizeBytes: 1 },
        {
          type: "file",
          fileId: 2,
          fileName: "b",
          sizeBytes: 1,
          mimeType: "image/webp",
        },
        {
          type: "file",
          fileId: 3,
          fileName: "c.md",
          sizeBytes: 1,
          mimeType: "text/markdown",
          // A stale value stored beside the type is replaced, not trusted.
          media: "image",
        },
        link,
      ],
      origin: null,
      launched_by_agent_id: null,
      delivered: null,
      read_at: null,
      created_at: now,
      updated_at: now,
    };
    expect(
      toBlock(row).attachments.map((a) =>
        a.type === "file" ? a.media : a.type
      )
    ).toEqual(["file", "image", "text", "link"]);
  });
});
