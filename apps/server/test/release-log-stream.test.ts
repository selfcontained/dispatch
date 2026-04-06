import { describe, expect, it } from "vitest";
import { ReleaseLogStreamProcessor } from "../src/release-log-stream.js";

function createHarness() {
  const log: string[] = [];

  const processor = new ReleaseLogStreamProcessor({
    append(line) {
      log.push(line);
    },
    replace(line) {
      if (log.length > 0) {
        log[log.length - 1] = line;
      } else {
        log.push(line);
      }
    },
    rewind(count) {
      if (count > 0) {
        log.splice(-count);
      }
    }
  });

  return { log, processor };
}

describe("ReleaseLogStreamProcessor", () => {
  it("dedupes cursor-up redraw blocks", () => {
    const { log, processor } = createHarness();

    processor.push("* main Release · 12345\n");
    processor.push("Triggered via workflow_dispatch\n");
    processor.push("\nJOBS\n");
    processor.push("* release (ID 999)\n");
    processor.push("✓ Set up job\n");
    processor.push("* Install dependencies\n");
    processor.push("* Build\n");
    processor.push("Refreshing run status every 3 seconds. Press Ctrl+C to quit.\n");

    processor.push("\x1b[9A\x1b[J");
    processor.push("* main Release · 12345\n");
    processor.push("Triggered via workflow_dispatch\n");
    processor.push("\nJOBS\n");
    processor.push("* release (ID 999)\n");
    processor.push("✓ Set up job\n");
    processor.push("✓ Install dependencies\n");
    processor.push("* Build\n");
    processor.push("Refreshing run status every 3 seconds. Press Ctrl+C to quit.\n");

    processor.push("\x1b[9A\x1b[J");
    processor.push("✓ main Release · 12345\n");
    processor.push("Triggered via workflow_dispatch\n");
    processor.push("\nJOBS\n");
    processor.push("✓ release (ID 999)\n");
    processor.push("✓ Set up job\n");
    processor.push("✓ Install dependencies\n");
    processor.push("✓ Build\n\n");
    processor.finish();

    expect(log).toEqual([
      "✓ main Release · 12345",
      "Triggered via workflow_dispatch",
      "",
      "JOBS",
      "✓ release (ID 999)",
      "✓ Set up job",
      "✓ Install dependencies",
      "✓ Build",
      ""
    ]);
  });

  it("handles full redraws via cursor-home sequences", () => {
    const { log, processor } = createHarness();

    processor.push("* first pass\n");
    processor.push("* still running\n");
    processor.push("\x1b[H\x1b[J");
    processor.push("✓ completed\n");
    processor.finish();

    expect(log).toEqual(["✓ completed"]);
  });

  it("handles split ansi chunks and carriage-return replacements", () => {
    const { log, processor } = createHarness();

    processor.push("Downloading");
    processor.push("\r");
    processor.push("Downloading.");
    processor.push("\rDownloading..\n");

    processor.push("\x1b[");
    processor.push("1A\x1b[J");
    processor.push("Done\n");
    processor.finish();

    expect(log).toEqual(["Done"]);
  });
});
