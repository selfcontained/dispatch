// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionLink } from "./agent-session-link";
import {
  Post,
  BlockView,
  blockAuthor,
  blockSide,
  type FeedContext,
} from "./chat/chat-entries";
import { InboxPanel } from "./inbox";
import { block, turnBlock } from "@/test-utils/blocks";
import type { Inbox } from "@/hooks/use-inbox";

const records = vi.hoisted(
  () =>
    new Map<
      string,
      { name: string; projectId?: string; seat?: number; rootId?: string }
    >()
);
vi.mock("@/hooks/use-agent-tree", () => ({
  useAgentRecord: (id: string) => records.get(id) ?? null,
}));
vi.mock("@/hooks/use-projects", () => ({
  useProjectScope: () => ({ projectId: "project current" }),
}));
vi.mock("@/hooks/use-stream", () => ({
  useAnswerQuestion: () => ({}),
  useSubmitForm: () => ({}),
  useSetBlockState: () => ({}),
}));
vi.mock("@/components/app/user-avatar/user-avatar", () => ({
  UserAvatar: () => <span>User face</span>,
}));
afterEach(() => {
  cleanup();
  records.clear();
});
function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  );
}
function ui(children: React.ReactNode) {
  return render(
    <MemoryRouter
      initialEntries={[
        "/tasks?project=project%20current&task=task1&thread=old",
      ]}
    >
      {children}
      <Location />
    </MemoryRouter>
  );
}
const ctx: FeedContext = {
  agentId: "assignee",
  rootId: "root",
  agentName: "Assignee",
  peers: {
    child: { name: "Builder", agentType: "codex", relation: "child", seat: 2 },
  },
  names: { archived: "Old name" },
  onOpenFile: vi.fn(),
};

describe("passive session identities", () => {
  it.each(["child", "root", "archived", "unnamed"])(
    "routes %s by stable ID, supports keyboard focus, and isolates parent controls",
    (id) => {
      records.set(id, {
        name: id === "unnamed" ? " " : "Renamed",
        projectId: "resolved project",
      });
      const click = vi.fn();
      const pointer = vi.fn();
      const key = vi.fn();
      ui(
        <div onClick={click} onPointerDown={pointer} onKeyDown={key}>
          <AgentSessionLink agentId={id} name="">
            <span>Icon</span>
          </AgentSessionLink>
        </div>
      );
      const link = screen.getByRole("link", {
        name: `Open ${id === "unnamed" ? "Agent" : "Renamed"} session`,
      });
      expect(link.getAttribute("href")).toBe(
        `/agents/${id}?project=resolved+project`
      );
      expect(link.getAttribute("draggable")).toBe("false");
      expect(link.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
      link.focus();
      expect(document.activeElement).toBe(link);
      expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(true);
      fireEvent.pointerDown(link);
      fireEvent.click(link);
      expect(click).not.toHaveBeenCalled();
      expect(pointer).not.toHaveBeenCalled();
      expect(key).not.toHaveBeenCalled();
      expect(screen.getByTestId("location").textContent).toBe(
        `/agents/${id}?project=resolved+project`
      );
      fireEvent.click(screen.getByText("Back"));
      expect(screen.getByTestId("location").textContent).toContain("/tasks?");
    }
  );

  it("links the actual task author and each recipient, independently of the assignee and root", () => {
    const message = block({
      streamId: "task1",
      author: { kind: "agent", agentId: "child" },
      toAgentId: "archived",
    });
    const author = blockAuthor(message, ctx);
    ui(
      <Post
        author={author}
        side={blockSide(message, ctx)}
        at={message.createdAt}
        grouped={false}
      >
        Message
      </Post>
    );
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/agents/child?project=project+current",
      "/agents/child?project=project+current",
      "/agents/archived?project=project+current",
    ]);
    expect(
      screen.getAllByRole("link", { name: "Open Builder session" })
    ).toHaveLength(2);
    expect(document.querySelector("a a, button a, a button")).toBeNull();
  });

  it("links pending-turn identity separately from the activity disclosure, keeping the small avatar", () => {
    const pending = turnBlock({
      author: { kind: "agent", agentId: "child" },
      text: "",
      turn: {
        settled: false,
        result: { text: "", streaming: true },
        trace: { startedAt: "2026-09-02T10:00:00Z", steps: [] },
      },
    });
    ui(
      <BlockView
        block={pending}
        ctx={ctx}
        grouped={false}
        answering={false}
        onAnswer={vi.fn()}
      />
    );
    const row = within(screen.getByTestId("chat-pending-turn"));
    expect(
      row.getAllByRole("link", { name: "Open Builder session" })
    ).toHaveLength(2);
    expect(row.getByTestId("chat-avatar-agent").className).toContain("h-5");
    expect(document.querySelector("button a, a button")).toBeNull();
  });

  it("retains individual recipients on agent-authored multi-recipient posts", () => {
    const message = block({
      author: { kind: "agent", agentId: "child" },
      toAgentId: "root",
      body: {
        kind: "text",
        data: { recipients: ["root", "archived"] },
        state: null,
      },
    });
    expect(
      blockSide(message, ctx)?.recipients.map((recipient) => recipient.agentId)
    ).toEqual(["root", "archived"]);
  });

  it("keeps user authors unlinked and retains individual multi-recipient IDs", () => {
    const message = block({
      authorKind: "user",
      toAgentId: "child",
      body: {
        kind: "text",
        data: { recipients: ["child", "archived"] },
        state: null,
      },
    });
    ui(
      <Post
        author={blockAuthor(message, ctx)}
        side={blockSide(message, ctx)}
        at={message.createdAt}
        grouped={false}
      >
        User message
      </Post>
    );
    expect(screen.getByTestId("chat-post-author").textContent).toBe("You");
    const recipients = within(
      screen.getByTestId("chat-side-recipient")
    ).getAllByRole("link");
    expect(recipients.map((link) => link.getAttribute("href"))).toEqual([
      "/agents/child?project=project+current",
      "/agents/archived?project=project+current",
    ]);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("keeps Inbox input/review/checklist actual author links separate from original-message controls", () => {
    const author = { kind: "agent" as const, agentId: "child" };
    const question = block({
      id: "question",
      author,
      body: { kind: "question", data: { options: [] }, state: {} },
    });
    const review = block({
      id: "review",
      author,
      body: { kind: "review", data: { summary: "Review" }, state: {} },
    });
    const checklist = block({
      id: "checklist",
      author,
      text: "Plan",
      body: {
        kind: "tasks",
        data: { items: [{ id: "one", text: "Implement" }] },
        state: { items: {} },
      },
    });
    const inbox = {
      rootId: "root",
      inputs: [question],
      reviews: [review],
      checklists: [checklist],
      links: [],
      agentNames: {},
      isLoading: false,
    } as Inbox;
    const open = vi.fn();
    ui(
      <InboxPanel
        inbox={inbox}
        agentName="Assignee"
        agentNameById={() => "Builder"}
        disabledReason={null}
        onOpenBlock={open}
      />
    );
    for (const kind of ["input", "review", "checklist"]) {
      const card = within(screen.getByTestId(`inbox-${kind}`));
      fireEvent.click(card.getByRole("link", { name: "Open Builder session" }));
      expect(open).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText("Back"));
      fireEvent.click(
        kind === "input"
          ? card.getByTestId("inbox-input-open")
          : card.getAllByRole("button", { name: /^Open / })[0]!
      );
      expect(open).toHaveBeenLastCalledWith(
        kind === "input" ? "question" : kind
      );
      open.mockClear();
    }
    expect(document.querySelector("button a, a button, a a")).toBeNull();
    expect(document.querySelector("button.absolute")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open original checklist: Plan" })
        .className
    ).toContain("select-text");
  });
  it("preserves review/checklist text selection without opening the message, while keyboard and normal clicks still work", () => {
    const checklist = block({
      id: "plan",
      author: { kind: "agent", agentId: "child" },
      text: "Select this plan",
      body: { kind: "tasks", data: { items: [] }, state: { items: {} } },
    });
    const review = block({
      id: "review",
      author: { kind: "agent", agentId: "child" },
      body: { kind: "review", data: { summary: "Review" }, state: {} },
    });
    const open = vi.fn();
    ui(
      <InboxPanel
        inbox={
          {
            rootId: "root",
            inputs: [],
            links: [],
            reviews: [review],
            checklists: [checklist],
            agentNames: {},
            isLoading: false,
          } as Inbox
        }
        agentName="Assignee"
        disabledReason={null}
        onOpenBlock={open}
      />
    );
    const selection = window.getSelection()!;
    for (const [name, id] of [
      ["Open original checklist: Select this plan", "plan"],
      ["Open review summary by Agent", "review"],
    ]) {
      const button = screen.getByRole("button", { name });
      const range = document.createRange();
      range.selectNodeContents(button);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(selection.isCollapsed).toBe(false);
      fireEvent.click(button, { detail: 1 });
      expect(open).not.toHaveBeenCalled();
      fireEvent.click(button, { detail: 0 });
      expect(open).toHaveBeenCalledWith(id);
      open.mockClear();
      selection.removeAllRanges();
      fireEvent.click(button, { detail: 1 });
      expect(open).toHaveBeenCalledWith(id);
      open.mockClear();
    }
  });
});
