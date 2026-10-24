// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { DOCS_SECTION_NAV, DocsContent } from "./docs-pane";
import { TASKS_DOC_URL } from "./docs-sections/tasks";

afterEach(cleanup);

describe("DocsContent tasks section", () => {
  it("is listed in the help nav", () => {
    expect(DOCS_SECTION_NAV).toContainEqual({ id: "tasks", label: "Tasks" });
  });

  it("renders the task tools and links the tasks doc", () => {
    render(
      <MemoryRouter>
        <DocsContent initialSection="tasks" />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Tasks");
    for (const tool of [
      "task_list",
      "task_get",
      "task_create",
      "task_update",
      "task_comment",
    ]) {
      expect(screen.getByText(tool)).toBeTruthy();
    }
    const link = screen.getByRole("link", { name: "docs/19-tasks.md" });
    expect(link.getAttribute("href")).toBe(TASKS_DOC_URL);
    expect(TASKS_DOC_URL.endsWith("/docs/19-tasks.md")).toBe(true);
  });
});
