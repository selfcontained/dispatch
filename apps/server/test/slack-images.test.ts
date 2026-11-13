import { describe, expect, it, vi } from "vitest";
import {
  SlackAuthError,
  SlackDeliveryUnknownError,
  SlackRejectedError,
  SlackRetryError,
} from "../src/notifications/slack-app.js";
import { sendWithImages } from "../src/notifications/slack-images.js";

const image = { type: "image", slack_file: { id: "F1" }, alt_text: "a.png" };
const notReady = () =>
  new SlackRejectedError("rejected", "invalid_blocks", true);
const harness = (outcomes: Array<Error | "ok">) => {
  const calls: unknown[][] = [];
  const send = vi.fn(async (images: unknown[]) => {
    calls.push(images);
    const next = outcomes.shift() ?? "ok";
    if (next !== "ok") throw next;
    return { ts: String(calls.length) };
  });
  const app = { waitForSendSlot: vi.fn(async () => {}) };
  const sleep = vi.fn(async () => {});
  const onRefused = vi.fn();
  return { calls, send, app, sleep, onRefused };
};

describe("sendWithImages", () => {
  it("sends text-only messages once", async () => {
    const h = harness([]);
    expect(await sendWithImages(h.app, [], h.send)).toEqual({
      sent: { ts: "1" },
    });
    expect(h.calls).toEqual([[]]);
  });

  it("retries the same images while Slack is still processing a fresh upload", async () => {
    const h = harness([notReady(), notReady(), "ok"]);
    const result = await sendWithImages(h.app, [image], h.send, {
      sleep: h.sleep,
      onRefused: h.onRefused,
    });
    expect(result).toEqual({ sent: { ts: "3" } });
    expect(h.calls).toEqual([[image], [image], [image]]);
    expect(h.sleep.mock.calls).toEqual([[1000], [2000]]);
    expect(h.app.waitForSendSlot).toHaveBeenCalledTimes(2);
    expect(h.onRefused).not.toHaveBeenCalled();
  });

  it("gives up after the bounded waits and sends the words once, saying why", async () => {
    const h = harness([notReady(), notReady(), notReady(), notReady()]);
    const result = await sendWithImages(h.app, [image], h.send, {
      sleep: h.sleep,
      onRefused: h.onRefused,
    });
    expect(result).toEqual({
      sent: { ts: "5" },
      note: "Images weren't attached: Slack was still processing them after several tries.",
    });
    expect(h.calls).toEqual([[image], [image], [image], [image], []]);
    expect(h.sleep.mock.calls).toEqual([[1000], [2000], [4000]]);
    expect(h.onRefused).toHaveBeenCalledWith("invalid_blocks", 4);
  });

  it("does not wait on other refusals; reports Slack's code", async () => {
    for (const error of [
      new SlackRejectedError("rejected", "invalid_blocks", false),
      new SlackRejectedError("rejected", "not_in_channel", false),
    ]) {
      const h = harness([error]);
      const result = await sendWithImages(h.app, [image], h.send, {
        sleep: h.sleep,
        onRefused: h.onRefused,
      });
      expect(result.note).toBe(
        `Images weren't attached: Slack refused them (${error.code}).`
      );
      expect(h.calls).toEqual([[image], []]);
      expect(h.sleep).not.toHaveBeenCalled();
      expect(h.onRefused).toHaveBeenCalledWith(error.code, 1);
    }
  });

  it("never resends after outcomes that may have posted, rate limits or auth failures", async () => {
    for (const error of [
      new SlackDeliveryUnknownError("unknown"),
      new SlackRetryError(1000),
      new SlackAuthError("auth"),
    ]) {
      const h = harness([error]);
      await expect(
        sendWithImages(h.app, [image], h.send, { sleep: h.sleep })
      ).rejects.toBe(error);
      expect(h.calls).toEqual([[image]]);
      expect(h.sleep).not.toHaveBeenCalled();
    }
  });
});
