/**
 * Design Lab — a comparison page for exploring depth/elevation styles.
 *
 * Renders mock Dispatch components (agent cards, sidebar, status badges, a modal,
 * nav bar, data rows) in four style treatments side by side:
 *   1. Current (flat baseline)
 *   2. Soft Elevation (layered shadows, hover lift)
 *   3. Layered Glass (backdrop blur, translucent panels)
 *   4. Editorial (depth via typography & spacing contrast)
 *
 * All styles are scoped via wrapper classNames — nothing leaks into the app.
 */

import { useEffect, useState } from "react";

import { FlaskConical, Layers3 } from "lucide-react";

import { DesignLabPrototypePlayground } from "@/components/app/design-lab-prototype-playground";

// -- Fake data ----------------------------------------------------------------
const agents = [
  {
    name: "PR Review Bot",
    status: "working" as const,
    model: "Claude Sonnet",
    branch: "feat/auth-refactor",
    elapsed: "4m 32s",
  },
  {
    name: "E2E Test Runner",
    status: "done" as const,
    model: "Claude Sonnet",
    branch: "main",
    elapsed: "12m 08s",
  },
  {
    name: "Migration Agent",
    status: "blocked" as const,
    model: "Claude Opus",
    branch: "fix/db-schema",
    elapsed: "1m 47s",
  },
  {
    name: "Deploy Monitor",
    status: "idle" as const,
    model: "Claude Haiku",
    branch: "main",
    elapsed: "--",
  },
];

const statusColors: Record<string, string> = {
  working: "bg-status-working/15 text-status-working border-status-working/40",
  done: "bg-status-done/15 text-status-done border-status-done/35",
  blocked: "bg-status-blocked/15 text-status-blocked border-status-blocked/40",
  idle: "bg-muted text-muted-foreground border-border",
};

const statusDots: Record<string, string> = {
  working: "bg-status-working",
  done: "bg-status-done",
  blocked: "bg-status-blocked",
  idle: "bg-muted-foreground/50",
};

// -- Style definitions --------------------------------------------------------
interface StyleDef {
  id: string;
  label: string;
  subtitle: string;
  wrapper: string;
  card: string;
  cardHover: string;
  sidebar: string;
  badge: string;
  modal: string;
  modalBackdrop: string;
  button: string;
  buttonPrimary: string;
  input: string;
  navItem: string;
  navItemActive: string;
  heading: string;
  subtext: string;
  dataRow: string;
  dataRowHover: string;
  separator: string;
}

const styles: StyleDef[] = [
  // 1. Current flat style
  {
    id: "current",
    label: "Current",
    subtitle: "Flat surfaces, thin borders, minimal shadows",
    wrapper: "bg-background",
    card: "rounded-xl border border-border bg-card text-card-foreground shadow-sm",
    cardHover: "hover:bg-muted/50",
    sidebar: "border-r border-border bg-card",
    badge:
      "rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
    modal: "rounded-xl border border-border bg-card p-6",
    modalBackdrop: "bg-black/50",
    button:
      "rounded-md border border-border bg-muted text-foreground px-3 py-2 text-sm font-medium hover:bg-muted/80",
    buttonPrimary:
      "rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium hover:bg-primary/90",
    input:
      "rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground",
    navItem:
      "rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted/70 hover:text-foreground",
    navItemActive: "rounded-md px-3 py-2 text-sm bg-muted text-foreground",
    heading: "text-lg font-semibold text-foreground",
    subtext: "text-sm text-muted-foreground",
    dataRow: "border-b border-border px-4 py-3",
    dataRowHover: "hover:bg-muted/40",
    separator: "border-t border-border",
  },
  // 2. Soft Elevation
  {
    id: "elevation",
    label: "Soft Elevation",
    subtitle: "Raised surfaces, glow halos, hover lift, inset inputs",
    wrapper: "bg-background",
    card: "rounded-xl border border-white/[0.06] bg-card text-card-foreground shadow-[0_2px_4px_rgba(0,0,0,0.4),0_8px_24px_rgba(0,0,0,0.3),0_0_0_1px_rgba(255,255,255,0.04)_inset]",
    cardHover:
      "hover:shadow-[0_4px_12px_rgba(0,0,0,0.5),0_16px_48px_rgba(0,0,0,0.35),0_0_24px_hsl(var(--primary)/0.06)] hover:-translate-y-1 transition-all duration-200",
    sidebar:
      "border-r border-white/[0.04] bg-[hsl(var(--card))] shadow-[4px_0_16px_rgba(0,0,0,0.3),1px_0_0_rgba(255,255,255,0.03)]",
    badge:
      "rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide shadow-[0_1px_4px_rgba(0,0,0,0.3)]",
    modal:
      "rounded-2xl border border-white/[0.08] bg-card p-6 shadow-[0_12px_48px_rgba(0,0,0,0.6),0_4px_16px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.06)_inset,0_0_80px_hsl(var(--primary)/0.05)]",
    modalBackdrop: "bg-black/65",
    button:
      "rounded-lg border border-white/[0.06] bg-muted text-foreground px-3 py-2 text-sm font-medium shadow-[0_2px_6px_rgba(0,0,0,0.3),0_0_0_1px_rgba(255,255,255,0.03)_inset] hover:shadow-[0_4px_12px_rgba(0,0,0,0.35)] hover:-translate-y-0.5 active:translate-y-0 active:shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-all duration-150",
    buttonPrimary:
      "rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm font-medium shadow-[0_2px_8px_rgba(0,0,0,0.3),0_0_16px_hsl(var(--primary)/0.15),0_1px_0_rgba(255,255,255,0.1)_inset] hover:shadow-[0_4px_16px_rgba(0,0,0,0.35),0_0_24px_hsl(var(--primary)/0.25)] hover:-translate-y-0.5 active:translate-y-0 transition-all duration-150",
    input:
      "rounded-lg border border-white/[0.04] bg-[hsl(var(--background))] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground shadow-[inset_0_2px_6px_rgba(0,0,0,0.35),inset_0_0_0_1px_rgba(0,0,0,0.15)] focus:shadow-[inset_0_2px_6px_rgba(0,0,0,0.35),0_0_0_2px_hsl(var(--ring)/0.35)]",
    navItem:
      "rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted/70 hover:text-foreground hover:shadow-[0_2px_8px_rgba(0,0,0,0.2)] transition-all duration-150",
    navItemActive:
      "rounded-lg px-3 py-2 text-sm bg-muted text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.06)]",
    heading: "text-lg font-semibold text-foreground",
    subtext: "text-sm text-muted-foreground",
    dataRow: "border-b border-white/[0.04] px-4 py-3",
    dataRowHover:
      "hover:bg-white/[0.02] hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)] transition-all duration-150",
    separator: "border-t border-white/[0.04]",
  },
  // 3. Layered Glass
  {
    id: "glass",
    label: "Layered Glass",
    subtitle:
      "Frosted blur, translucent panels, luminous borders, glowing accents",
    wrapper:
      "bg-background bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.08),transparent_60%),radial-gradient(ellipse_at_bottom_right,hsl(var(--status-done)/0.06),transparent_50%)]",
    card: "rounded-xl border border-white/[0.12] bg-white/[0.04] backdrop-blur-xl text-card-foreground shadow-[0_4px_24px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.08)]",
    cardHover:
      "hover:border-white/[0.18] hover:bg-white/[0.07] hover:shadow-[0_4px_24px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.12),0_0_20px_hsl(var(--primary)/0.06)] transition-all duration-250",
    sidebar:
      "border-r border-white/[0.1] bg-white/[0.03] backdrop-blur-2xl shadow-[inset_-1px_0_0_rgba(255,255,255,0.06)]",
    badge:
      "rounded-full border border-white/[0.12] px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide bg-white/[0.06] backdrop-blur-md shadow-[0_1px_4px_rgba(0,0,0,0.2)]",
    modal:
      "rounded-2xl border border-white/[0.15] bg-white/[0.06] backdrop-blur-2xl p-6 shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.12),0_0_40px_hsl(var(--primary)/0.06)]",
    modalBackdrop: "bg-black/50 backdrop-blur-md",
    button:
      "rounded-lg border border-white/[0.12] bg-white/[0.06] backdrop-blur-md text-foreground px-3 py-2 text-sm font-medium shadow-[0_1px_4px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.06)] hover:bg-white/[0.1] hover:border-white/[0.18] transition-all duration-150",
    buttonPrimary:
      "rounded-lg bg-primary/80 backdrop-blur-md text-primary-foreground px-3 py-2 text-sm font-medium border border-white/[0.15] shadow-[0_2px_8px_rgba(0,0,0,0.25),0_0_20px_hsl(var(--primary)/0.25),inset_0_1px_0_rgba(255,255,255,0.15)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.25),0_0_32px_hsl(var(--primary)/0.35)] hover:bg-primary/90 transition-all duration-150",
    input:
      "rounded-lg border border-white/[0.1] bg-black/20 backdrop-blur-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 shadow-[inset_0_1px_4px_rgba(0,0,0,0.2)] focus:border-white/[0.2] focus:shadow-[inset_0_1px_4px_rgba(0,0,0,0.2),0_0_0_2px_hsl(var(--ring)/0.25)]",
    navItem:
      "rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-white/[0.06] hover:text-foreground transition-all duration-150",
    navItemActive:
      "rounded-lg px-3 py-2 text-sm bg-white/[0.08] text-foreground border border-white/[0.1] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
    heading:
      "text-lg font-semibold text-foreground drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]",
    subtext: "text-sm text-muted-foreground/80",
    dataRow: "border-b border-white/[0.06] px-4 py-3",
    dataRowHover: "hover:bg-white/[0.04] transition-colors duration-150",
    separator: "border-t border-white/[0.08]",
  },
  // 4. Editorial
  {
    id: "editorial",
    label: "Editorial",
    subtitle: "Bold type hierarchy, generous spacing, depth through contrast",
    wrapper: "bg-[hsl(var(--surface))]",
    card: "rounded-2xl bg-card text-card-foreground border-0",
    cardHover:
      "hover:bg-[hsl(var(--muted)/0.5)] transition-colors duration-200",
    sidebar: "bg-[hsl(var(--background))] border-r-0 shadow-none",
    badge:
      "rounded-md border-0 bg-muted px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.15em]",
    modal:
      "rounded-3xl border-0 bg-card p-10 shadow-[0_32px_80px_rgba(0,0,0,0.6)]",
    modalBackdrop: "bg-black/75",
    button:
      "rounded-xl border-0 bg-muted text-foreground px-5 py-3 text-sm font-semibold tracking-wide hover:bg-muted/80 transition-colors duration-150",
    buttonPrimary:
      "rounded-xl border-0 bg-primary text-primary-foreground px-5 py-3 text-sm font-semibold tracking-wide hover:bg-primary/90 transition-colors duration-150",
    input:
      "rounded-xl border-2 border-transparent bg-muted/40 px-5 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:bg-muted/60 focus:border-primary/30 focus:ring-0 transition-all duration-150",
    navItem:
      "rounded-xl px-4 py-3 text-sm font-medium text-muted-foreground/70 hover:text-foreground transition-colors duration-150",
    navItemActive:
      "rounded-xl px-4 py-3 text-sm font-black text-foreground border-l-2 border-primary",
    heading: "text-2xl font-black tracking-tight text-foreground",
    subtext:
      "text-xs text-muted-foreground/60 font-light tracking-[0.08em] uppercase",
    dataRow: "px-6 py-5",
    dataRowHover: "hover:bg-muted/15 transition-colors duration-150",
    separator: "border-t border-white/[0.04]",
  },
];

// -- Mock Components ----------------------------------------------------------

function StatusBadge({ status, style }: { status: string; style: StyleDef }) {
  return (
    <span className={`${style.badge} ${statusColors[status]}`}>{status}</span>
  );
}

function AgentCard({
  agent,
  style,
}: {
  agent: (typeof agents)[0];
  style: StyleDef;
}) {
  return (
    <div className={`${style.card} ${style.cardHover} p-4 cursor-pointer`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${statusDots[agent.status]}`} />
          <span className="text-sm font-medium text-foreground">
            {agent.name}
          </span>
        </div>
        <StatusBadge status={agent.status} style={style} />
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{agent.model}</span>
        <span className="opacity-40">|</span>
        <span className="font-mono">{agent.branch}</span>
        <span className="ml-auto tabular-nums">{agent.elapsed}</span>
      </div>
    </div>
  );
}

function MockSidebar({ style }: { style: StyleDef }) {
  return (
    <div
      className={`${style.sidebar} w-64 p-3 flex flex-col gap-1 rounded-l-xl`}
    >
      <div className="flex items-center gap-2 px-3 py-2 mb-3">
        <div className="w-5 h-5 rounded bg-primary/80" />
        <span className="text-sm font-semibold text-foreground">Dispatch</span>
      </div>
      <div className="px-3 mb-2">
        <span className={style.subtext}>Navigation</span>
      </div>
      {["Agents", "Jobs", "Activity", "Settings"].map((item, i) => (
        <button
          key={item}
          className={`text-left ${i === 0 ? style.navItemActive : style.navItem}`}
        >
          {item}
        </button>
      ))}
      <div className={`${style.separator} my-3`} />
      <div className="px-3 mb-2">
        <span className={style.subtext}>System</span>
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <div className="w-1.5 h-1.5 rounded-full bg-status-working" />
        <span className="text-xs text-muted-foreground">API</span>
        <span className="text-xs text-status-working ml-auto">ok</span>
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <div className="w-1.5 h-1.5 rounded-full bg-status-working" />
        <span className="text-xs text-muted-foreground">DB</span>
        <span className="text-xs text-status-working ml-auto">ok</span>
      </div>
    </div>
  );
}

function MockModal({ style }: { style: StyleDef }) {
  return (
    <div className="relative">
      <div className={`absolute inset-0 rounded-xl ${style.modalBackdrop}`} />
      <div className="relative flex items-center justify-center py-12 px-8">
        <div className={`${style.modal} w-full max-w-sm`}>
          <h3 className={`${style.heading} mb-1`}>Create Agent</h3>
          <p className={`${style.subtext} mb-5`}>
            Configure a new agent session.
          </p>
          <div className="space-y-3 mb-5">
            <input
              className={`${style.input} w-full`}
              placeholder="Agent name"
            />
            <input
              className={`${style.input} w-full`}
              placeholder="~/path/to/project"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button className={style.button}>Cancel</button>
            <button className={style.buttonPrimary}>Create</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MockDataTable({ style }: { style: StyleDef }) {
  const rows = [
    {
      name: "Nightly E2E",
      schedule: "0 2 * * *",
      lastRun: "2h ago",
      status: "done",
    },
    {
      name: "PR Triage",
      schedule: "*/30 * * * *",
      lastRun: "12m ago",
      status: "working",
    },
    {
      name: "Stale Branch Cleanup",
      schedule: "0 9 * * 1",
      lastRun: "3d ago",
      status: "blocked",
    },
  ];
  return (
    <div className={`${style.card} overflow-hidden`}>
      <div className="px-4 py-3">
        <span className={style.heading}>Jobs</span>
      </div>
      <div className={style.separator} />
      <div
        className={`${style.dataRow} flex items-center text-xs font-medium text-muted-foreground uppercase tracking-wider`}
      >
        <span className="flex-1">Name</span>
        <span className="w-32">Schedule</span>
        <span className="w-24">Last Run</span>
        <span className="w-20 text-right">Status</span>
      </div>
      {rows.map((row) => (
        <div
          key={row.name}
          className={`${style.dataRow} ${style.dataRowHover} flex items-center text-sm cursor-pointer`}
        >
          <span className="flex-1 font-medium text-foreground">{row.name}</span>
          <span className="w-32 font-mono text-xs text-muted-foreground">
            {row.schedule}
          </span>
          <span className="w-24 text-muted-foreground">{row.lastRun}</span>
          <span className="w-20 text-right">
            <StatusBadge status={row.status} style={style} />
          </span>
        </div>
      ))}
    </div>
  );
}

// -- Full variant preview -----------------------------------------------------

function VariantPreview({ style }: { style: StyleDef }) {
  return (
    <div
      className={`${style.wrapper} rounded-xl border border-border/30 overflow-hidden`}
    >
      <div className="px-6 py-4 border-b border-border/30">
        <h2 className="text-xl font-bold text-foreground">{style.label}</h2>
        <p className={style.subtext}>{style.subtitle}</p>
      </div>

      <div className="flex min-h-[520px]">
        <MockSidebar style={style} />
        <div className="flex-1 p-5 space-y-5 overflow-hidden">
          <div>
            <h3 className={`${style.heading} mb-3`}>Agent Cards</h3>
            <div className="grid grid-cols-2 gap-3">
              {agents.map((a) => (
                <AgentCard key={a.name} agent={a} style={style} />
              ))}
            </div>
          </div>

          <MockDataTable style={style} />

          <div>
            <h3 className={`${style.heading} mb-3`}>Controls</h3>
            <div className="flex items-center gap-3 flex-wrap">
              <button className={style.button}>Default</button>
              <button className={style.buttonPrimary}>Primary</button>
              <input
                className={`${style.input} w-48`}
                placeholder="Search agents..."
              />
              {(["working", "done", "blocked", "idle"] as const).map((s) => (
                <StatusBadge key={s} status={s} style={style} />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-border/30">
        <div className="px-6 py-3">
          <h3 className={`${style.heading} mb-0`}>Modal</h3>
        </div>
        <MockModal style={style} />
      </div>
    </div>
  );
}

// -- Main page ----------------------------------------------------------------

type LabMode = "prototype" | "surface";

export function DesignLab() {
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<LabMode>("prototype");
  const visibleStyles = selected
    ? styles.filter((s) => s.id === selected)
    : styles;

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent =
      "html, body, #root { overflow: auto !important; height: auto !important; }";
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  return (
    <div className="min-h-screen bg-surface p-8">
      <div className="max-w-[1600px] mx-auto mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">
          Design Lab
        </h1>
        <p className="text-muted-foreground mb-6">
          A UI playground for prototype work and visual studies inside Dispatch.
          Prototype Playground is the new foundation for agent-built mocks, and
          Surface Study preserves the older visual comparison work.
        </p>

        <div className="mb-6 flex gap-2 flex-wrap">
          <button
            onClick={() => setMode("prototype")}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === "prototype"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            <FlaskConical className="h-4 w-4" />
            Prototype Playground
          </button>
          <button
            onClick={() => setMode("surface")}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === "surface"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            <Layers3 className="h-4 w-4" />
            Surface Study
          </button>
        </div>

        {mode === "surface" ? (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setSelected(null)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                selected === null
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              All
            </button>
            {styles.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelected(selected === s.id ? null : s.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  selected === s.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="max-w-[1600px] mx-auto space-y-10">
        {mode === "prototype" ? (
          <DesignLabPrototypePlayground />
        ) : (
          visibleStyles.map((s) => <VariantPreview key={s.id} style={s} />)
        )}
      </div>
    </div>
  );
}
