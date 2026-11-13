import { describe, expect, it } from "vitest";
import {
  SlackApiError,
  SlackAuthError,
  SlackDeliveryUnknownError,
  SlackRetryError,
} from "../src/notifications/slack-app.js";
import {
  IMAGE_READY_RETRY_MS,
  postWithImages,
} from "../src/notifications/slack-images.js";
import type { SlackBlock } from "../src/notifications/slack-blocks.js";

const image = {
  type: "image",
  slack_file: { id: "F1" },
  alt_text: "shot.png",
} as SlackBlock;
const processing = () =>
  new SlackApiError({
    error: "invalid_blocks",
    errors: ["invalid slack file [json-pointer:/blocks/2/slack_file]"],
  });

function harness(failures: unknown[]) {
  const posts: SlackBlock[][] = [];
  const slept: number[] = [];
  let slots = 0;
  const run = (pictures: { blocks: SlackBlock[]; skipped?: string }) =>
    postWithImages(
      {
        waitForSendSlot: async () => {
          slots++;
        },
      },
      pictures,
      async (images) => {
        posts.push(images);
        const failure = failures.shift();
        if (failure) throw failure;
        return { ts: String(posts.length) };
      },
      async (ms) => {
        slept.push(ms);
      }
    );
  return { run, posts, slept, slots: () => slots };
}

describe("SlackApiError", () => {
  it("keeps only Slack's code and whether it named a slack_file", () => {
    const e = new SlackApiError({
      error: "invalid_blocks",
      response_metadata: {
        messages: [
          "[ERROR] invalid slack file [json-pointer:/blocks/1/slack_file]",
        ],
      },
    });
    expect(e.code).toBe("invalid_blocks");
    expect(e.slackFileRejected).toBe(true);
    expect(e.message).not.toMatch(/json-pointer|slack file/);
    expect(
      new SlackApiError({ error: "invalid_blocks" }).slackFileRejected
    ).toBe(false);
    expect(
      new SlackApiError({ error: "channel_not_found", errors: ["slack_file"] })
        .slackFileRejected
    ).toBe(false);
    // Anything that isn't a plain Slack code is not echoed.
    expect(new SlackApiError({ error: "xoxb-secret <https://x>" }).code).toBe(
      "unknown_error"
    );
    expect(new SlackApiError({}).code).toBe("unknown_error");
  });
});

describe("postWithImages", () => {
  it("posts once with images when Slack accepts them", async () => {
    const h = harness([]);
    expect(await h.run({ blocks: [image] })).toEqual({ sent: { ts: "1" } });
    expect(h.posts).toEqual([[image]]);
    expect(h.slept).toEqual([]);
  });

  it("without images posts the words once and passes on why images were skipped", async () => {
    const h = harness([]);
    expect(await h.run({ blocks: [], skipped: "needs files:write" })).toEqual({
      sent: { ts: "1" },
      note: "needs files:write",
    });
    expect(h.posts).toEqual([[]]);
  });

  it("waits for a still-processing image and posts the same message again", async () => {
    const h = harness([processing(), processing()]);
    expect(await h.run({ blocks: [image] })).toEqual({ sent: { ts: "3" } });
    expect(h.posts).toEqual([[image], [image], [image]]);
    expect(h.slept).toEqual(IMAGE_READY_RETRY_MS.slice(0, 2));
    expect(h.slots()).toBe(2);
  });

  it("gives up after the bounded waits and sends the words once, saying why", async () => {
    const h = harness(
      Array.from({ length: IMAGE_READY_RETRY_MS.length + 1 }, processing)
    );
    const result = await h.run({ blocks: [image] });
    expect(result.note).toMatch(
      /still hadn't finished processing.*\(invalid_blocks\)/
    );
    expect(result.rejectedCode).toBe("invalid_blocks");
    expect(h.posts).toHaveLength(IMAGE_READY_RETRY_MS.length + 2);
    expect(h.posts.at(-1)).toEqual([]);
    expect(h.posts.slice(0, -1).every((p) => p[0] === image)).toBe(true);
  });

  it("another definite rejection sends the words once without retrying the images", async () => {
    const h = harness([new SlackApiError({ error: "invalid_blocks" })]);
    const result = await h.run({ blocks: [image] });
    expect(result).toMatchObject({
      sent: { ts: "2" },
      rejectedCode: "invalid_blocks",
      note: expect.stringMatching(
        /rejected the message with them \(invalid_blocks\)/
      ),
    });
    expect(h.posts).toEqual([[image], []]);
    expect(h.slept).toEqual([]);
  });

  it("never retries an outcome that may have posted, a rate limit or bad credentials", async () => {
    for (const error of [
      new SlackDeliveryUnknownError("timeout"),
      new SlackRetryError(1000),
      new SlackAuthError("revoked"),
    ]) {
      const h = harness([error]);
      await expect(h.run({ blocks: [image] })).rejects.toBe(error);
      expect(h.posts).toHaveLength(1);
    }
  });

  it("a text fallback that itself fails is reported as a failure, not sent", async () => {
    const fallback = new SlackDeliveryUnknownError("timeout");
    const h = harness([
      new SlackApiError({ error: "invalid_blocks" }),
      fallback,
    ]);
    await expect(h.run({ blocks: [image] })).rejects.toBe(fallback);
    expect(h.posts).toHaveLength(2);
  });
});
