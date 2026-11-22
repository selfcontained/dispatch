// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSvgPreview } from "./workspace-svg-preview";
vi.mock("./files-text-preview", () => ({
  FilesTextPreview: ({ text }: { text: string }) => <pre>{text}</pre>,
}));
afterEach(cleanup);
it("defaults to an image and switches to source and back", () => {
  const text = '<svg viewBox="0 0 40 20" />';
  render(
    <WorkspaceSvgPreview
      fileName="preview.svg"
      preview={{ src: "data:image/svg+xml;base64,PHN2Zy8+", text }}
    />
  );
  const option = (name: string) => screen.getByRole("radio", { name });
  expect(option("Preview").getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("img").getAttribute("src")).toContain(
    "data:image/svg+xml"
  );
  fireEvent.click(option("Code"));
  expect(option("Code").getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText(text)).toBeTruthy();
  fireEvent.click(option("Preview"));
  expect(screen.getByRole("img")).toBeTruthy();
});
