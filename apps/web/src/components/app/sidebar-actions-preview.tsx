import { useState } from "react";
import {
  ChevronDown,
  GitBranch,
  Folder,
  MoreHorizontal,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";

const options = [
  [
    "Grouped toolbar",
    "Labeled groups expose commands immediately, at the cost of a taller expanded row.",
  ],
  [
    "Review + menu",
    "Review takes priority while a grouped menu saves space and adds a click for secondary commands.",
  ],
  [
    "Contextual actions",
    "Commands sit beside the information they affect, trading a compact toolbar for more scanning.",
  ],
];
const branch = "dispatch/sidebar-expanded-agent-action-layout-exploration";
const workspace =
  "/workspace/dispatch/.dispatch/worktrees/sidebar-action-layouts";

/** Disposable design fixture: deliberately has no API or lifecycle mutations. */
export function SidebarActionsPreview(): JSX.Element {
  const [option, setOption] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [status, setStatus] = useState("Running");
  const [pinned, setPinned] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState(
    "Fixture ready. Commands affect this preview only."
  );
  const disabled = status === "Archiving";
  function act(command: string) {
    if (
      command === "Pause" ||
      command === "Archive" ||
      command === "Change workspace"
    ) {
      setPending(command);
      return;
    }
    if (command === "Resume") setStatus("Running");
    if (command === "Pin" || command === "Unpin") setPinned(!pinned);
    if (command === "Copy worktree path") {
      void navigator.clipboard.writeText(workspace).then(
        () => setFeedback("Worktree path copied."),
        () => setFeedback(`Copy path: ${workspace}`)
      );
      return;
    }
    setFeedback(`${command} — fixture interaction complete.`);
  }
  const commands = [
    status === "Stopped" ? "Resume" : "Pause",
    "Session details",
    pinned ? "Unpin" : "Pin",
    "Archive",
  ];
  const blocked = (label: string) =>
    (disabled &&
      label !== "Session details" &&
      label !== "Pin" &&
      label !== "Unpin") ||
    (label === "Review" && status === "Stopped");
  const control = (label: string, primary = false) => (
    <Button
      key={label}
      variant={primary ? "primary" : "ghost"}
      className={`min-h-11 h-auto px-3 text-xs ${label === "Archive" ? "text-destructive" : ""}`}
      disabled={blocked(label)}
      onClick={() => act(label)}
    >
      {label}
    </Button>
  );
  const menu = (label: string, groups: string[][]) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="default"
          className="min-h-11 gap-2 px-3 text-xs"
          aria-label={label}
        >
          {label}
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {groups.map((group, i) => (
          <div key={i}>
            {i > 0 && <DropdownMenuSeparator />}
            <div>{["Review", "Workspace", "Session"][i]}</div>
            {group.map((command) => (
              <DropdownMenuItem
                key={command}
                className={`min-h-11 ${command === "Archive" ? "text-destructive" : ""}`}
                disabled={blocked(command)}
                onSelect={() => act(command)}
              >
                {command}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const workspaceControls = (
    <div className="flex flex-wrap">
      {["Open editor", "Change workspace", "Copy worktree path"].map((label) =>
        control(label)
      )}
    </div>
  );
  return (
    <main className="h-dvh overflow-auto bg-background text-foreground">
      <header className="border-b p-5">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Dispatch / Design study
        </p>
        <h1 className="mt-2 text-xl font-semibold">Expanded agent actions</h1>
        <div
          className="mt-4 flex flex-wrap gap-2"
          role="group"
          aria-label="Design options"
        >
          {options.map(([name], i) => (
            <Button
              key={name}
              variant={option === i ? "primary" : "default"}
              aria-pressed={option === i}
              onClick={() => {
                setOption(i);
                setExpanded(true);
              }}
            >
              {i + 1}. {name}
            </Button>
          ))}
        </div>
        <p className="mt-3 max-w-xl text-sm text-muted-foreground">
          {options[option][1]}
        </p>
      </header>
      <div className="flex min-h-[700px] flex-wrap">
        <aside
          aria-label="Agent sidebar"
          className="w-[352px] max-w-full shrink-0 border-r bg-muted/10"
        >
          <div className="border-b px-4 py-4 text-sm font-semibold">
            Dispatch{" "}
            <span className="float-right font-normal text-muted-foreground">
              3 agents
            </span>
          </div>
          <div className="border-b px-4 py-4 text-sm">
            ○ <span className="ml-2">Release verification</span>
            <p className="ml-6 mt-1 text-xs text-muted-foreground">
              Idle · Codex
            </p>
          </div>
          <section className="border-b border-r-4 border-r-emerald-500 bg-muted/40 p-3">
            <button
              className="flex min-h-11 w-full items-center gap-2 rounded-md text-left focus-visible:outline focus-visible:outline-2"
              aria-expanded={expanded}
              aria-controls="expanded-conductor"
              onClick={() => setExpanded(!expanded)}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-background">
                C
              </span>
              <span
                className="min-w-0 flex-1 truncate font-medium"
                title="Conductor — sidebar action layout exploration"
              >
                Conductor — sidebar action layout exploration
              </span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
            <p className="mt-2 text-xs text-muted-foreground">
              <span className="text-emerald-500">●</span> {status} · Exploring
              expanded agent actions
            </p>
            {expanded && (
              <div id="expanded-conductor" className="mt-3 space-y-3">
                {option === 2 && (
                  <div className="flex flex-wrap items-center border-b pb-2">
                    {control("Review", true)}
                    {menu("Session commands", [
                      ["Choose persona"],
                      [],
                      commands,
                    ])}
                  </div>
                )}
                <div className="space-y-3 rounded-xl border bg-background/30 p-3 text-xs">
                  <div className="flex gap-2">
                    <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-muted-foreground">main</p>
                      <p className="mt-1 break-all font-mono" title={branch}>
                        ↳ {branch}
                      </p>
                    </div>
                  </div>
                  <p>Codex · gpt-6.1-sol</p>
                  <p>Persona · Conductor</p>
                  {option === 2 && (
                    <>
                      <div className="flex gap-2">
                        <Folder className="h-4 w-4 shrink-0" />
                        <span className="break-all font-mono text-muted-foreground">
                          {workspace}
                        </span>
                      </div>
                      {workspaceControls}
                    </>
                  )}
                  <p className="flex items-center gap-1 text-muted-foreground">
                    <ShieldCheck className="h-3 w-3" />
                    Restricted access
                  </p>
                </div>
                {option === 0 && (
                  <>
                    <div>
                      <p className="text-xs text-muted-foreground">Review</p>
                      <div className="flex">
                        {control("Review", true)}
                        {control("Choose persona")}
                      </div>
                    </div>
                    <div className="border-t pt-2">
                      <p className="text-xs text-muted-foreground">Workspace</p>
                      {workspaceControls}
                    </div>
                    <div className="border-t pt-2">
                      <p className="text-xs text-muted-foreground">Session</p>
                      <div className="flex flex-wrap">
                        {commands.map((label) => control(label))}
                      </div>
                    </div>
                  </>
                )}
                {option === 1 && (
                  <div className="flex justify-between gap-2">
                    {control("Review", true)}
                    {menu("More commands", [
                      ["Choose persona"],
                      ["Open editor", "Change workspace", "Copy worktree path"],
                      commands,
                    ])}
                  </div>
                )}
              </div>
            )}
          </section>
          <div className="border-b px-4 py-4 text-sm">
            ○ <span className="ml-2">Investigate queue retries</span>
            <p className="ml-6 mt-1 text-xs text-muted-foreground">
              Stopped · Codex
            </p>
          </div>
        </aside>
        <section className="min-w-0 flex-1 p-5">
          <h2 className="font-medium">Conductor</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Disposable interaction fixture
          </p>
          <p role="status" className="mt-5 max-w-lg break-words text-sm">
            {feedback}
          </p>
          <div
            className="mt-6 flex flex-wrap gap-2"
            role="group"
            aria-label="Fixture states"
          >
            {["Running", "Stopped", "Archiving"].map((state) => (
              <Button
                key={state}
                variant="default"
                aria-pressed={status === state}
                onClick={() => setStatus(state)}
              >
                {state}
              </Button>
            ))}
          </div>
        </section>
      </div>
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <div>
            <AlertDialogTitle>{pending} Conductor?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending === "Archive"
                ? "Archiving stops this session and removes it from the active sidebar."
                : pending === "Pause"
                  ? "Pausing interrupts the current turn. You can resume the session later."
                  : "Changing workspace moves where the agent works. The engine launch directory stays unchanged."}{" "}
              This fixture changes no real agent.
            </AlertDialogDescription>
          </div>
          <div>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending === "Pause") setStatus("Stopped");
                if (pending === "Archive") setStatus("Archiving");
                setFeedback(`${pending} confirmed in disposable fixture.`);
                setPending(null);
              }}
            >
              Confirm {pending}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
