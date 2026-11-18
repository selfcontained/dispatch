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
  expect(screen.getByRole("img").getAttribute("src")).toContain(
    "data:image/svg+xml"
  );
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Code" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText(text)).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Preview" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(screen.getByRole("img")).toBeTruthy();
});
