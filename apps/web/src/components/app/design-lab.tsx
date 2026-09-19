import { useState, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  FileText,
  ListChecks,
  Square,
} from "lucide-react";

import { DayDivider, Post, type PostAuthor } from "@/components/app/chat/chat-entries";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { THEMES, useTheme, type ThemeId } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

/**
 * Design Lab: the stream-of-blocks proposal rendered with Dispatch's own
 * posts, tokens and primitives. Every message, tool call, pin, file and
 * question in the "run" and "chat" scenes is real data from the acp-runtime
 * dev stack; the preview-server scene is staged.
 */

const YOU: PostAuthor = { key: "user", name: "You", kind: "user" };
const SMOKE: PostAuthor = {
  key: "agent",
  name: "ui smoke",
  kind: "agent",
  agentType: "claude",
};
const THINKING: PostAuthor = {
  key: "agent",
  name: "thinking ui",
  kind: "agent",
  agentType: "claude",
};
const STARTUP: PostAuthor = {
  key: "peer:startup",
  name: "startup ui",
  kind: "peer",
  agentType: "claude",
  relation: "sibling",
};

const T = (h: number, m: number) =>
  new Date(2026, 8, 19, h, m).toISOString();

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

function Mark({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="my-2 flex items-center gap-3 px-4 text-[11px] text-muted-foreground/70">
      <span className="h-px flex-1 bg-border/50" />
      <span>{children}</span>
      <span className="h-px flex-1 bg-border/50" />
    </div>
  );
}

type Step = { label: string; ms: number; output?: string };

function Activity({
  steps,
  total,
  defaultOpen = false,
}: {
  steps: Step[];
  total: string;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded px-0.5 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
        />
        <Check className="h-3 w-3 text-status-working" strokeWidth={2.5} />
        <span>
          {steps.length} steps · {total}
        </span>
      </button>
      {open ? (
        <div className="ml-[5px] mt-1 grid gap-0.5 border-l-2 border-border/50 pl-4 font-terminal text-[11.5px]">
          {steps.map((s, i) => (
            <div key={i}>
              <div className="flex min-w-0 gap-2">
                <Check
                  className="mt-0.5 h-3 w-3 shrink-0 text-status-working"
                  strokeWidth={2.5}
                />
                <span className="truncate">{s.label}</span>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/60">
                  {(s.ms / 1000).toFixed(1)}s
                </span>
              </div>
              {s.output ? (
                <pre className="my-1 overflow-x-auto rounded-md bg-background px-2 py-1.5 text-[11px] text-foreground/80">
                  {s.output}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Thinking({ since }: { since: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <ActivityBars size={11} className="justify-center" />
      <span>thinking</span>
      <span className="tabular-nums text-muted-foreground/60">{since}</span>
    </div>
  );
}

function Card({
  icon,
  title,
  aside,
  tone = "default",
  children,
}: {
  icon?: ReactNode;
  title?: string;
  aside?: ReactNode;
  tone?: "default" | "waiting" | "live" | "blocked";
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        "max-w-[72ch] overflow-hidden rounded-lg border bg-card",
        tone === "waiting" && "border-l-2 border-l-status-waiting border-border",
        tone === "live" && "border-status-working/50",
        tone === "blocked" && "border-l-2 border-l-status-blocked border-border",
        tone === "default" && "border-border"
      )}
    >
      {title ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-1.5 text-[11.5px] text-muted-foreground">
          {icon}
          <span className="font-semibold text-foreground">{title}</span>
          {aside ? <span className="ml-auto">{aside}</span> : null}
        </div>
      ) : null}
      <div className="px-3 py-2.5">{children}</div>
    </div>
  );
}

function Tasks({
  items,
}: {
  items: { text: string; state: "done" | "now" | "todo" }[];
}): JSX.Element {
  const done = items.filter((i) => i.state === "done").length;
  return (
    <Card
      icon={<ListChecks className="h-3.5 w-3.5" />}
      title="Tasks"
      aside={`${done} of ${items.length}`}
    >
      <div className="grid gap-1.5 text-sm">
        {items.map((t) => (
          <div key={t.text} className="flex items-center gap-2">
            <span
              className={cn(
                "grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border",
                t.state === "done" &&
                  "border-status-working bg-status-working text-background",
                t.state === "now" && "border-status-done",
                t.state === "todo" && "border-muted-foreground/50"
              )}
            >
              {t.state === "done" ? (
                <Check className="h-2.5 w-2.5" strokeWidth={3} />
              ) : null}
            </span>
            <span
              className={cn(
                t.state === "done" && "text-muted-foreground line-through",
                t.state === "now" && "font-medium text-status-done"
              )}
            >
              {t.text}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Chips({
  items,
}: {
  items: { kind: string; value: string; href?: string }[];
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((c) => (
        <span
          key={c.kind + c.value}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-xs",
            c.href ? "border-status-done/40" : "border-border"
          )}
        >
          <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
            {c.kind}
          </span>
          {c.href ? (
            <span className="text-status-done">{c.value}</span>
          ) : (
            <span className="font-terminal">{c.value}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function File({
  name,
  meta,
  preview,
}: {
  name: string;
  meta: string;
  preview?: string;
}): JSX.Element {
  return (
    <Card>
      <div className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3">
        <span className="grid h-12 w-10 place-items-center rounded-md border border-border bg-muted/40 text-muted-foreground">
          <FileText className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{name}</div>
          <div className="text-xs text-muted-foreground">{meta}</div>
        </div>
        {preview ? (
          <pre className="col-span-2 mt-1 overflow-x-auto rounded-md bg-muted/40 px-2.5 py-2 font-terminal text-[11.5px] text-muted-foreground">
            {preview}
          </pre>
        ) : null}
      </div>
    </Card>
  );
}

function Question({
  text,
  options,
  answered,
}: {
  text: ReactNode;
  options: string[];
  answered?: string;
}): JSX.Element {
  return (
    <Card
      tone="waiting"
      icon={<CircleHelp className="h-3.5 w-3.5 text-status-waiting" />}
      title="Question"
      aside={answered ? "answered" : "waiting on you"}
    >
      <div className="grid gap-2.5">
        <div className="text-sm">{text}</div>
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <Button
              key={o}
              size="sm"
              variant={answered === o ? "success" : "default"}
              disabled={answered !== undefined && answered !== o}
              className="h-7 text-xs"
            >
              {answered === o ? <Check className="mr-1 h-3 w-3" /> : null}
              {o}
            </Button>
          ))}
        </div>
        {answered ? null : (
          <div className="text-xs text-muted-foreground">
            Or type an answer below.
          </div>
        )}
      </div>
    </Card>
  );
}

function Preview({
  url,
  meta,
  off = false,
}: {
  url: string;
  meta: string;
  off?: boolean;
}): JSX.Element {
  return (
    <Card tone={off ? "default" : "live"}>
      <div
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3",
          off && "opacity-60"
        )}
      >
        <div className="min-w-0">
          <div
            className={cn(
              "flex items-center gap-1.5 text-[11px] font-semibold tracking-wide",
              off ? "text-muted-foreground" : "text-status-working"
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                off
                  ? "bg-muted-foreground"
                  : "bg-status-working shadow-[0_0_0_3px_hsl(var(--status-working)/0.2)]"
              )}
            />
            {off ? "OFF" : "LIVE"}
          </div>
          <div
            className={cn(
              "truncate font-terminal text-sm font-medium",
              off && "line-through"
            )}
          >
            {url}
          </div>
          <div className="text-xs text-muted-foreground">{meta}</div>
        </div>
        <Button
          size="sm"
          variant={off ? "default" : "primary"}
          className="h-8"
          disabled={off}
        >
          Open <ExternalLink className="ml-1 h-3 w-3" />
        </Button>
      </div>
    </Card>
  );
}

function Finding({
  severity,
  title,
  loc,
  body,
}: {
  severity: string;
  title: string;
  loc: string;
  body: string;
}): JSX.Element {
  return (
    <Card
      tone="blocked"
      title={title}
      icon={
        <span className="rounded bg-status-blocked/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-blocked">
          {severity}
        </span>
      }
      aside="open"
    >
      <div className="font-terminal text-xs text-muted-foreground">{loc}</div>
      <div className="mt-1 text-sm">{body}</div>
    </Card>
  );
}

function SentTo({
  to,
  text,
}: {
  to: string;
  text: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
        Sent to
      </span>
      <span className="font-medium text-foreground">{to}</span>
      <span className="min-w-0 flex-1 truncate">{text}</span>
    </div>
  );
}

function Blocks({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-2 grid max-w-[72ch] gap-2">{children}</div>;
}

// ---------------------------------------------------------------------------
// Frame: stream + live-only rail, at the pane's real proportions
// ---------------------------------------------------------------------------

function Filters({
  items,
}: {
  items: { label: string; count?: number; on?: boolean }[];
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5 px-4 pt-2">
      {items.map((f) => (
        <span
          key={f.label}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-[11.5px]",
            f.on
              ? "border-status-done/50 bg-status-done/10 text-status-done"
              : "border-border text-muted-foreground"
          )}
        >
          {f.label}
          {f.count !== undefined ? (
            <span className="ml-1 font-semibold text-foreground">{f.count}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function Presence({
  tone,
  text,
  stop = false,
}: {
  tone: "working" | "waiting" | "idle";
  text: string;
  stop?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-4 pt-3 text-xs text-muted-foreground">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          tone === "working" && "bg-status-done",
          tone === "waiting" && "bg-status-waiting",
          tone === "idle" && "bg-status-working"
        )}
      />
      <span
        className={cn(
          "font-medium",
          tone === "working" && "text-status-done",
          tone === "waiting" && "text-status-waiting",
          tone === "idle" && "text-status-working"
        )}
      >
        {tone === "working" ? "Working" : tone === "waiting" ? "Waiting" : "Idle"}
      </span>
      <span>· {text}</span>
      {stop ? (
        <Button size="sm" variant="default" className="ml-auto h-6 gap-1 px-2 text-xs">
          <Square className="h-3 w-3 fill-current" /> Stop
        </Button>
      ) : null}
    </div>
  );
}

function Composer({ placeholder }: { placeholder: string }): JSX.Element {
  return (
    <div className="mx-4 my-3 flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground/70">
      <span>{placeholder}</span>
      <span className="grid h-7 w-7 place-items-center rounded-md border border-border bg-muted/40 text-muted-foreground">
        ➤
      </span>
    </div>
  );
}

function Rail({ children }: { children: ReactNode }): JSX.Element {
  return (
    <aside className="grid content-start gap-4 border-t border-border bg-muted/20 p-3 text-xs lg:border-l lg:border-t-0">
      {children}
    </aside>
  );
}

function RailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
        {title}
      </div>
      {children}
    </div>
  );
}

function Frame({
  name,
  meta,
  filters,
  children,
  presence,
  composer,
  rail,
}: {
  name: string;
  meta: string;
  filters: { label: string; count?: number; on?: boolean }[];
  children: ReactNode;
  presence: ReactNode;
  composer: string;
  rail: ReactNode;
}): JSX.Element {
  return (
    <div className="grid overflow-hidden rounded-xl border border-border bg-background lg:grid-cols-[minmax(0,1fr)_248px]">
      <main className="min-w-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm">
          <span className="font-semibold"># {name}</span>
          <span className="text-xs text-muted-foreground">{meta}</span>
        </div>
        <Filters items={filters} />
        <div className="py-2">{children}</div>
        {presence}
        <Composer placeholder={composer} />
      </main>
      <Rail>{rail}</Rail>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

function RunScene(): JSX.Element {
  return (
    <Frame
      name="ui smoke"
      meta="scratch-repo · ui-smoke branch"
      filters={[
        { label: "All", on: true },
        { label: "Messages" },
        { label: "Files", count: 1 },
        { label: "Artifacts", count: 2 },
        { label: "Questions", count: 1 },
        { label: "Activity" },
      ]}
      presence={
        <Presence tone="waiting" text="Asking whether to keep or delete hello.js" />
      }
      composer="Answer, or message ui smoke…"
      rail={
        <>
          <RailSection title="Now">
            <div>
              <span className="font-semibold text-status-waiting">Waiting</span>{" "}
              · keep or delete hello.js?
            </div>
          </RailSection>
          <RailSection title="Open question">
            <div className="flex items-center gap-2">
              <CircleHelp className="h-3.5 w-3.5 text-status-waiting" />
              <span className="truncate">keep or delete hello.js</span>
              <span className="ml-auto text-muted-foreground/60">9:20</span>
            </div>
          </RailSection>
          <RailSection title="Tasks">
            <div className="grid gap-1 text-muted-foreground">
              {[
                "Create hello.js and run it",
                "Write NOTES.md",
                "Commit, pin, share",
              ].map((t) => (
                <div key={t} className="flex items-center gap-2">
                  <Check className="h-3 w-3 text-status-working" strokeWidth={2.5} />
                  <span className="line-through">{t}</span>
                </div>
              ))}
            </div>
          </RailSection>
        </>
      }
    >
      <DayDivider label="Today" />
      <Mark>reattached 9:20 AM · the host outlived a server restart</Mark>
      <Post author={YOU} at={T(9, 20)} grouped={false}>
        <Markdown>
          Do a small multi-step task in this worktree: create hello.js that
          prints the current date, run it, write a NOTES.md describing the
          repo, commit, pin the commit hash and a preview URL, share NOTES.md,
          and finally ask me whether to keep or delete hello.js.
        </Markdown>
      </Post>
      <Post author={SMOKE} at={T(9, 20)} grouped={false}>
        <Blocks>
          <Tasks
            items={[
              { text: "Create hello.js and run it", state: "done" },
              { text: "Write NOTES.md", state: "done" },
              { text: "Commit, pin, share", state: "done" },
            ]}
          />
          <Activity
            total="25s"
            steps={[
              { label: "Write hello.js", ms: 1685 },
              {
                label: "node hello.js",
                ms: 613,
                output: "Sat Sep 19 2026 09:20:20 GMT-0600 (Mountain Daylight Time)",
              },
              { label: "Write NOTES.md", ms: 4556 },
              {
                label:
                  'git add hello.js NOTES.md && git commit -q -m "Add hello.js and NOTES.md"',
                ms: 1313,
              },
              { label: "pin Commit", ms: 1312 },
              { label: "share_file NOTES.md", ms: 1682 },
              { label: "pin Preview", ms: 1143 },
              { label: "chat_post (question)", ms: 2260 },
            ]}
          />
        </Blocks>
        <div className="mt-2">
          <Markdown>
            {`All steps done:

1. \`hello.js\` — \`console.log(new Date().toString())\`
2. Ran it — printed \`Sat Sep 19 2026 09:20:20 GMT-0600\`
3. \`NOTES.md\` — describes the repo and both files
4. Committed as \`7c8e620\`, pins set, NOTES.md shared.`}
          </Markdown>
        </div>
        <Blocks>
          <Chips
            items={[
              { kind: "commit", value: "7c8e620" },
              { kind: "preview", value: "localhost:4173", href: "#" },
            ]}
          />
          <File
            name="NOTES.md"
            meta="632 B · shared 9:20 AM"
            preview={`# scratch-repo
A throwaway repo used to exercise the Dispatch agent runtime.
Files: README.md (heading only), notes.txt ("hello"), hello.js (prints the date).`}
          />
          <Question
            text={
              <>
                Should I keep <code>hello.js</code> or remove it?
              </>
            }
            options={["Keep hello.js", "Delete hello.js"]}
          />
        </Blocks>
      </Post>
    </Frame>
  );
}

function ChatScene(): JSX.Element {
  return (
    <Frame
      name="thinking ui"
      meta="scratch-repo · thinking-ui branch"
      filters={[
        { label: "All", on: true },
        { label: "Messages" },
        { label: "startup ui", count: 4 },
        { label: "Activity" },
      ]}
      presence={<Presence tone="idle" text="replied to startup ui" />}
      composer="Message thinking ui…"
      rail={
        <>
          <RailSection title="Now">
            <div>
              <span className="font-semibold text-status-working">Idle</span> ·
              replied to startup ui
            </div>
          </RailSection>
          <div className="text-muted-foreground/70">
            Nothing open. The rail only holds what is live: a running turn, an
            unanswered question, the current plan, a preview that is up.
          </div>
        </>
      }
    >
      <DayDivider label="Yesterday" />
      <Mark>session started 11:52 PM · worktree, deps and Claude Code up in 9s</Mark>
      <Post author={YOU} at={T(23, 52)} grouped={false}>
        <div className="mb-1">
          <Badge variant="default" className="text-[10px]">
            launch prompt
          </Badge>
        </div>
        Think very carefully and at length about the tradeoffs of monorepos
        versus polyrepos before answering; then answer in two sentences. No
        tools.
      </Post>
      <Post author={THINKING} at={T(23, 52)} grouped={false}>
        Monorepos make atomic cross-project changes, shared tooling, consistent
        dependency versions, and large refactors much easier. The cost is
        heavier build and CI infrastructure (you need incremental builds and
        scoped tests), weaker ownership boundaries, and tooling that strains as
        the repo grows. Polyrepos give teams independence, clear access
        control, and simpler per-repo pipelines. In exchange, cross-repo
        changes need coordinated versioning and releases, dependencies drift
        apart, and shared code is harder to discover and reuse.
      </Post>
      <Post author={YOU} at={T(23, 53)} grouped={false} rule>
        Think hard and at length (really deliberate) about whether Postgres or
        SQLite fits a single-user desktop app, then answer in one sentence. No
        tools.
      </Post>
      <Post author={THINKING} at={T(23, 53)} grouped={false}>
        SQLite fits: it's an embedded, zero-configuration, single-file database
        that runs in your app's process and handles one user's workload easily,
        while Postgres would make you install, run, and upgrade a separate
        server on each user's machine for concurrency and networking features a
        single-user app won't use.
      </Post>
      <Mark>stopped 11:53 PM</Mark>
      <DayDivider label="Today" />
      <Mark>resumed 12:08 AM · same session, history intact</Mark>
      <Post author={STARTUP} at={T(0, 8)} grouped={false}>
        Can you summarize the repo README in one line for me?
      </Post>
      <Post author={THINKING} at={T(0, 8)} grouped={false}>
        <Blocks>
          <Activity
            total="10.5s"
            steps={[
              { label: "ls -a; cat README* 2>/dev/null | head -20", ms: 666 },
              { label: "read README.md", ms: 200 },
              { label: "post → startup ui", ms: 1300 },
            ]}
          />
        </Blocks>
        <div className="mt-2">
          Another agent, "startup ui", asked me for a one-line summary of this
          repo's README, so I sent it one. The README contains only the heading{" "}
          <code># scratch</code>, so I told them it's an empty scratch repo with
          nothing else to summarize.
        </div>
        <Blocks>
          <SentTo
            to="startup ui"
            text='README.md only has the heading "# scratch", so it’s an empty scratch repo…'
          />
        </Blocks>
      </Post>
      <Post author={STARTUP} at={T(0, 10)} grouped={false} rule>
        How many files are in the repo? Reply in one line.
      </Post>
      <Post author={THINKING} at={T(0, 10)} grouped={false}>
        "startup ui" also asked how many files are in the repo. I told them
        there are 2, README.md and notes.txt, not counting <code>.git</code>.
        <Blocks>
          <SentTo
            to="startup ui"
            text="2 files, README.md and notes.txt, not counting .git."
          />
        </Blocks>
      </Post>
    </Frame>
  );
}

function PreviewScene(): JSX.Element {
  return (
    <Frame
      name="ui smoke"
      meta="scratch-repo"
      filters={[
        { label: "All", on: true },
        { label: "Messages" },
        { label: "Files", count: 1 },
        { label: "Artifacts", count: 1 },
        { label: "Preview", count: 1 },
      ]}
      presence={<Presence tone="working" text="restarting preview on :4174" stop />}
      composer="Message ui smoke…"
      rail={
        <>
          <div className="rounded-lg border border-status-working/60 bg-card px-3 py-2">
            <div className="font-terminal text-xs font-semibold">localhost:4174</div>
            <div className="text-[11px] text-muted-foreground">
              Preview · live since 9:31 · Open ↗
            </div>
          </div>
          <RailSection title="Now">
            <div>
              <span className="font-semibold text-status-done">Working</span> ·
              restarting preview
            </div>
          </RailSection>
        </>
      }
    >
      <DayDivider label="Today" />
      <Post author={YOU} at={T(9, 24)} grouped={false}>
        Start a static preview of the repo so I can look at NOTES.md rendered.
      </Post>
      <Post author={SMOKE} at={T(9, 24)} grouped={false}>
        <Blocks>
          <Activity
            total="1.9s"
            steps={[{ label: "npx serve -l 4173 . (background)", ms: 1900 }]}
          />
        </Blocks>
        <div className="mt-2">
          Preview is up. It serves the worktree root, so NOTES.md is at
          /NOTES.md.
        </div>
        <Blocks>
          <Preview
            url="http://localhost:4174"
            meta="serve · started 9:24, moved to 4174 at 9:31"
          />
        </Blocks>
      </Post>
      <Post author={YOU} at={T(9, 31)} grouped={false} rule>
        4173 collides with something on my machine, move it.
      </Post>
      <Post author={SMOKE} at={T(9, 31)} grouped={false}>
        <Blocks>
          <Activity
            total="2.4s"
            steps={[{ label: "kill serve; npx serve -l 4174 . (background)", ms: 2400 }]}
          />
        </Blocks>
        <div className="mt-2">
          Moved to 4174. The card above is updated; the old port is released.
        </div>
        <Blocks>
          <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
            <span className="rounded bg-status-working/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-working">
              Preview updated
            </span>
            <span>now serving on localhost:4174</span>
          </div>
        </Blocks>
      </Post>
      <div className="opacity-70">
        <Post author={YOU} at={T(9, 52)} grouped={false} rule>
          Done, you can shut the preview down.
        </Post>
        <Post author={SMOKE} at={T(9, 52)} grouped={false}>
          Stopped the preview server.
          <Blocks>
            <Preview url="http://localhost:4174" meta="turned off 9:52 · drops out of the rail" off />
          </Blocks>
        </Post>
      </div>
    </Frame>
  );
}

function Gallery(): JSX.Element {
  const cap = (k: string, d: string) => (
    <div className="text-xs text-muted-foreground">
      <span className="font-terminal font-medium text-foreground">{k}</span> · {d}
    </div>
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <div className="grid content-start gap-2">
        {cap("activity", "tool calls and thoughts, folded")}
        <Activity total="10.5s" steps={[{ label: "read README.md", ms: 200 }]} />
        <Thinking since="4s" />
      </div>
      <div className="grid content-start gap-2">
        {cap("artifact", "commit, PR, URL, decision (replaces pins)")}
        <Chips
          items={[
            { kind: "commit", value: "7c8e620" },
            { kind: "pr", value: "#1091 acp runtime", href: "#" },
            { kind: "decision", value: "keep tmux out" },
          ]}
        />
      </div>
      <div className="grid content-start gap-2">
        {cap("file", "shared file or screenshot (replaces media)")}
        <File name="ui-turn.png" meta="104 KB · screenshot" />
      </div>
      <div className="grid content-start gap-2">
        {cap("question", "options or free text; the agent's Waiting state")}
        <Question
          text={
            <>
              Keep <code>hello.js</code>?
            </>
          }
          options={["Keep hello.js", "Delete hello.js"]}
          answered="Keep hello.js"
        />
      </div>
      <div className="grid content-start gap-2">
        {cap("tasks", "the plan, updated in place")}
        <Tasks
          items={[
            { text: "Read the README", state: "done" },
            { text: "Write the migration", state: "now" },
            { text: "Run the suite", state: "todo" },
          ]}
        />
      </div>
      <div className="grid content-start gap-2">
        {cap("preview", "a running server, updated and turned off in place")}
        <Preview url="http://localhost:5173" meta="vite · started 10:02" />
      </div>
      <div className="grid content-start gap-2">
        {cap("finding", "a review finding with a resolution thread")}
        <Finding
          severity="important"
          title="Host token written world-readable"
          loc="apps/server/src/agents/acp/runtime.ts:214"
          body="launch.json holds the MCP token; write it with mode 0600."
        />
      </div>
      <div className="grid content-start gap-2">
        {cap("peer", "a message to or from another agent")}
        <div className="rounded-lg border border-border">
          <Post author={STARTUP} at={T(0, 8)} grouped={false}>
            Can you summarize the README in one line?
          </Post>
          <div className="px-4 pb-3">
            <SentTo to="startup ui" text="it's an empty scratch repo." />
          </div>
        </div>
      </div>
      <div className="grid content-start gap-2">
        {cap("mark", "lifecycle, never a post")}
        <div className="rounded-lg border border-border py-2">
          <Mark>session started 11:52 PM</Mark>
          <Mark>reattached 9:20 AM · host outlived a restart</Mark>
          <div className="my-2 flex items-center gap-3 px-4 text-[11px] text-status-blocked">
            <span className="h-px flex-1 bg-border/50" />
            <span>engine exited with code 1 · 9:41 AM</span>
            <span className="h-px flex-1 bg-border/50" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ThemePicker({
  theme,
  setTheme,
}: {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-xs uppercase tracking-wide text-muted-foreground">
        Theme
      </span>
      {THEMES.map((t) => (
        <button
          key={t.id}
          onClick={() => setTheme(t.id)}
          className={`group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
            theme === t.id
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
          title={t.description}
        >
          <span className="flex gap-0.5">
            {t.swatches.slice(0, 3).map((swatch, i) => (
              <span
                key={i}
                className="h-3 w-3 rounded-sm border border-black/20"
                style={{ backgroundColor: swatch }}
              />
            ))}
          </span>
          {t.label}
        </button>
      ))}
    </div>
  );
}

const SCENES = [
  { id: "run", label: "Autonomous run", render: RunScene },
  { id: "chat", label: "Chatty session", render: ChatScene },
  { id: "preview", label: "Preview server", render: PreviewScene },
  { id: "gallery", label: "Block gallery", render: Gallery },
] as const;

export function DesignLab(): JSX.Element {
  const { theme, setTheme } = useTheme();
  const [scene, setScene] = useState<(typeof SCENES)[number]["id"]>("run");
  const Scene = SCENES.find((s) => s.id === scene)?.render ?? RunScene;

  return (
    <div className="bg-background p-6 md:p-8">
      <div className="mx-auto max-w-[1400px]">
        <header className="mb-6">
          <h1 className="mb-1 text-2xl font-bold tracking-tight text-foreground">
            Design Lab · Stream blocks
          </h1>
          <p className="max-w-[72ch] text-sm text-muted-foreground">
            The proposed block model rendered with Dispatch's own posts and
            tokens. Real dev-stack data in the run and chat scenes; the preview
            server is staged. The rail holds only what is live; everything
            durable stays in the stream behind the filter chips.
          </p>
        </header>

        <div className="sticky top-0 z-10 -mx-2 mb-6 flex flex-wrap items-center gap-4 rounded-xl border border-border bg-background/80 px-4 py-3 backdrop-blur">
          <ThemePicker theme={theme} setTheme={setTheme} />
          <div className="flex flex-wrap gap-1.5" role="tablist">
            {SCENES.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={scene === s.id}
                onClick={() => setScene(s.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs",
                  scene === s.id
                    ? "border-status-working/60 bg-status-working/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <Scene />
      </div>
    </div>
  );
}
