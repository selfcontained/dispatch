import { describe, expect, it } from "vitest";

import { classifyPickerPage } from "./picker-access";

describe("classifyPickerPage", () => {
  it.each(["http://localhost:3000", "https://work.example.test/dashboard"])(
    "allows selection on web page %s",
    (url) => {
      expect(classifyPickerPage(url)).toBe("ready");
    }
  );

  it("requests site access when Chrome withholds the active tab URL", () => {
    expect(classifyPickerPage()).toBe("needs-site-access");
  });

  it.each(["chrome://extensions", "file:///tmp/example.html"])(
    "rejects browser-owned or non-web page %s",
    (url) => {
      expect(classifyPickerPage(url)).toBe("unsupported");
    }
  );
});
