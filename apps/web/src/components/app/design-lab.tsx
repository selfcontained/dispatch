import { useEffect, useState } from "react";
import { THEMES, useTheme, type ThemeId } from "@/hooks/use-theme";

// -- Keyframes ----------------------------------------------------------------

const SPINNER_KEYFRAMES = `
@keyframes dl-material-dash {
  0%   { stroke-dasharray: 1, 63; stroke-dashoffset: 0; }
  50%  { stroke-dasharray: 44, 63; stroke-dashoffset: -16; }
  100% { stroke-dasharray: 44, 63; stroke-dashoffset: -60; }
}
@keyframes dl-pulse-dot {
  0%, 80%, 100% { transform: scale(0.5); opacity: 0.4; }
  40%           { transform: scale(1);   opacity: 1; }
}
@keyframes dl-bar-pulse {
  0%, 100% { transform: scaleY(0.35); }
  50%      { transform: scaleY(1); }
}
/* Activity Bars: wave left→right, bounces off the right end, right→left,
   rests. Bar 3 briefly holds at peak during the turnaround. */
@keyframes dl-bar-wave-0 {
  0%, 5%, 25%, 67%, 87%, 100% { transform: scaleY(0.22); }
  10%, 20%, 72%, 82%          { transform: scaleY(0.55); }
  15%, 77%                    { transform: scaleY(1); }
}
@keyframes dl-bar-wave-1 {
  0%, 13%, 33%, 59%, 79%, 100% { transform: scaleY(0.22); }
  18%, 28%, 64%, 74%           { transform: scaleY(0.55); }
  23%, 69%                     { transform: scaleY(1); }
}
@keyframes dl-bar-wave-2 {
  0%, 21%, 41%, 51%, 71%, 100% { transform: scaleY(0.22); }
  26%, 36%, 56%, 66%           { transform: scaleY(0.55); }
  31%, 61%                     { transform: scaleY(1); }
}
@keyframes dl-bar-wave-3 {
  0%, 29%, 44%, 47%, 63%, 100% { transform: scaleY(0.22); }
  34%, 50%, 58%                { transform: scaleY(0.55); }
  39%, 53%                     { transform: scaleY(1); }
}
@keyframes dl-indeterminate-bar {
  0%   { transform: translateX(-100%) scaleX(0.4); }
  50%  { transform: translateX(0%)    scaleX(0.6); }
  100% { transform: translateX(100%)  scaleX(0.4); }
}
`;

// -- Color system -------------------------------------------------------------

type ColorVariant = "mono" | "gradient" | "multi";

const THEME_COLOR = {
  primary: "hsl(var(--primary))",
  working: "hsl(var(--status-working))",
  done: "hsl(var(--status-done))",
  waiting: "hsl(var(--status-waiting))",
  blocked: "hsl(var(--status-blocked))",
} as const;

// Multi sequence picks distinct theme colors, ordered to avoid clashing hues.
const MULTI_SEQUENCE = [
  THEME_COLOR.primary,
  THEME_COLOR.done,
  THEME_COLOR.working,
  THEME_COLOR.waiting,
  THEME_COLOR.blocked,
];

// 3-stop gradient for the "gradient" variant — visible even on short arcs.
const GRADIENT_STOPS = [
  THEME_COLOR.primary,
  THEME_COLOR.done,
  THEME_COLOR.working,
];

// Conic gradient string — used where we want a full rainbow around a full 360°.
function conicGradient(stops: string[], from = "0deg"): string {
  const ring = [...stops, stops[0]]; // close the loop
  const pieces = ring
    .map((c, i) => `${c} ${((i / (ring.length - 1)) * 360).toFixed(0)}deg`)
    .join(", ");
  return `conic-gradient(from ${from}, ${pieces})`;
}

function multiColorAt(index: number): string {
  return MULTI_SEQUENCE[index % MULTI_SEQUENCE.length]!;
}

// -- Spinner components -------------------------------------------------------

interface SpinnerProps {
  size?: number;
  variant: ColorVariant;
  className?: string;
}

function ringMask(size: number, thickness: number): string {
  const inner = Math.max(0, size / 2 - thickness);
  return `radial-gradient(circle at center, transparent ${inner}px, black ${inner + 0.5}px, black ${size / 2}px)`;
}

function ringMaskStyle(size: number, thickness: number): React.CSSProperties {
  const m = ringMask(size, thickness);
  return { WebkitMask: m, mask: m };
}

function MaterialArcSpinner({ size = 32, variant, className }: SpinnerProps) {
  // Mono keeps the classic Material dash-and-rotate arc.
  if (variant === "mono") {
    const stroke = Math.max(1.5, size / 10);
    return (
      <svg
        className={`animate-spin ${className ?? ""}`}
        style={{
          width: size,
          height: size,
          animationDuration: "1.4s",
          color: THEME_COLOR.primary,
        }}
        viewBox="0 0 24 24"
        fill="none"
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          style={{
            animation: "dl-material-dash 1.4s ease-in-out infinite",
            transformOrigin: "center",
          }}
        />
      </svg>
    );
  }

  // Gradient / multi render as a conic-gradient ring with an arc cut out.
  // A second `mask-image` fades one portion of the ring so it still reads as an arc.
  const thickness = Math.max(2, size / 9);
  const stops = variant === "gradient" ? GRADIENT_STOPS : MULTI_SEQUENCE;
  const bg = conicGradient([...stops, stops[0]!]);
  return (
    <div
      className={`animate-spin rounded-full ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        background: bg,
        animationDuration: "1.1s",
        ...ringMaskStyle(size, thickness),
      }}
    />
  );
}

function DualRingSpinner({ size = 32, variant, className }: SpinnerProps) {
  const outerThickness = Math.max(2, size / 10);
  const innerThickness = Math.max(1.5, size / 12);
  const innerSize = Math.round(size * 0.55);

  if (variant === "mono") {
    const stroke = Math.max(1.5, size / 12);
    return (
      <div
        className={`relative ${className ?? ""}`}
        style={{ width: size, height: size, color: THEME_COLOR.primary }}
      >
        <svg
          className="absolute inset-0 animate-spin"
          style={{ animationDuration: "1.1s" }}
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeOpacity="0.18"
            strokeWidth={stroke}
          />
          <path
            d="M 12 2 A 10 10 0 0 1 22 12"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
          />
        </svg>
        <svg
          className="absolute inset-0 animate-spin"
          style={{ animationDuration: "0.8s", animationDirection: "reverse" }}
          viewBox="0 0 24 24"
          fill="none"
        >
          <path
            d="M 12 6 A 6 6 0 0 1 18 12"
            stroke="currentColor"
            strokeOpacity="0.55"
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </div>
    );
  }

  const outerColors =
    variant === "gradient"
      ? [THEME_COLOR.primary, THEME_COLOR.done, THEME_COLOR.primary]
      : [
          THEME_COLOR.primary,
          THEME_COLOR.done,
          THEME_COLOR.working,
          THEME_COLOR.waiting,
          THEME_COLOR.primary,
        ];
  const innerColors =
    variant === "gradient"
      ? [THEME_COLOR.done, THEME_COLOR.primary, THEME_COLOR.done]
      : [
          THEME_COLOR.waiting,
          THEME_COLOR.blocked,
          THEME_COLOR.working,
          THEME_COLOR.waiting,
        ];

  return (
    <div
      className={`relative ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      <div
        className="absolute inset-0 animate-spin rounded-full"
        style={{
          background: conicGradient(outerColors),
          animationDuration: "1.1s",
          ...ringMaskStyle(size, outerThickness),
        }}
      />
      <div
        className="absolute animate-spin rounded-full"
        style={{
          width: innerSize,
          height: innerSize,
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: conicGradient(innerColors, "90deg"),
          animationDuration: "0.8s",
          animationDirection: "reverse",
          ...ringMaskStyle(innerSize, innerThickness),
        }}
      />
    </div>
  );
}

function OrbitSpinner({ size = 32, variant, className }: SpinnerProps) {
  const dot = Math.max(2, size / 6);

  const dotStyle = (index: number, opacity: number): React.CSSProperties => {
    if (variant === "mono") {
      return { backgroundColor: THEME_COLOR.primary, opacity };
    }
    if (variant === "gradient") {
      // Each dot is a radial gradient from primary to done — opacity still trails.
      return {
        backgroundImage: `radial-gradient(circle at 30% 30%, ${THEME_COLOR.primary}, ${THEME_COLOR.done})`,
        opacity,
      };
    }
    // multi: each dot gets a distinct theme color.
    return { backgroundColor: multiColorAt(index) };
  };

  return (
    <div
      className={`relative animate-spin ${className ?? ""}`}
      style={{ width: size, height: size, animationDuration: "1s" }}
    >
      <div
        className="absolute rounded-full"
        style={{
          width: dot,
          height: dot,
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          ...dotStyle(0, 1),
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: dot,
          height: dot,
          bottom: "10%",
          right: "10%",
          ...dotStyle(1, 0.6),
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: dot,
          height: dot,
          bottom: "10%",
          left: "10%",
          ...dotStyle(2, 0.3),
        }}
      />
    </div>
  );
}

function PulseDotsSpinner({ size = 32, variant, className }: SpinnerProps) {
  const dot = Math.max(3, size / 4);
  const gap = Math.max(2, size / 8);

  const dotStyle = (i: number): React.CSSProperties => {
    if (variant === "mono") return { backgroundColor: THEME_COLOR.primary };
    if (variant === "multi") return { backgroundColor: multiColorAt(i) };
    // gradient: each dot gets a radial gradient sampled from a different point
    // along the primary→done transition — so the row reads as a smooth sweep.
    const starts = [THEME_COLOR.primary, THEME_COLOR.done, THEME_COLOR.working];
    const ends = [THEME_COLOR.done, THEME_COLOR.working, THEME_COLOR.primary];
    return {
      backgroundImage: `radial-gradient(circle at 30% 30%, ${starts[i]}, ${ends[i]})`,
    };
  };

  return (
    <div
      className={`flex items-center ${className ?? ""}`}
      style={{ gap, height: size }}
    >
      {[0, 0.16, 0.32].map((delay, i) => (
        <div
          key={delay}
          className="rounded-full"
          style={{
            width: dot,
            height: dot,
            animation: "dl-pulse-dot 1.2s ease-in-out infinite",
            animationDelay: `${delay}s`,
            ...dotStyle(i),
          }}
        />
      ))}
    </div>
  );
}

function RadarSpinner({ size = 32, variant, className }: SpinnerProps) {
  // A rotating conic "sweep" — transparent on the back side, color-rich on the
  // leading edge so it feels like a scanner.
  const thickness = Math.max(2, size / 9);

  const sweep =
    variant === "mono"
      ? `conic-gradient(from 0deg, transparent 0deg, ${THEME_COLOR.primary} 270deg, ${THEME_COLOR.primary} 360deg)`
      : variant === "gradient"
        ? `conic-gradient(from 0deg, transparent 0deg, ${THEME_COLOR.primary} 120deg, ${THEME_COLOR.done} 240deg, ${THEME_COLOR.working} 360deg)`
        : `conic-gradient(from 0deg, transparent 0deg, ${THEME_COLOR.blocked} 60deg, ${THEME_COLOR.waiting} 150deg, ${THEME_COLOR.working} 240deg, ${THEME_COLOR.done} 320deg, ${THEME_COLOR.primary} 360deg)`;

  return (
    <div
      className={`relative ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{
          border: `${Math.max(1, thickness * 0.4)}px solid ${THEME_COLOR.primary}`,
          opacity: 0.12,
        }}
      />
      <div
        className="absolute inset-0 animate-spin rounded-full"
        style={{
          background: sweep,
          animationDuration: "1.1s",
          ...ringMaskStyle(size, thickness),
        }}
      />
    </div>
  );
}

function ActivityBarsSpinner({ size = 32, variant, className }: SpinnerProps) {
  const bar = Math.max(2, size / 8);
  const gap = Math.max(1, size / 12);

  // Rainbow palette specific to this spinner — avoids the primary/done hue
  // collision several themes have, so each bar reads as a distinct color.
  const RAINBOW = [
    THEME_COLOR.blocked,
    THEME_COLOR.waiting,
    THEME_COLOR.working,
    THEME_COLOR.done,
  ];

  const barStyle = (i: number): React.CSSProperties => {
    if (variant === "mono") return { backgroundColor: THEME_COLOR.primary };
    if (variant === "multi") {
      return {
        backgroundColor: RAINBOW[i % RAINBOW.length],
        filter: "saturate(1.35) brightness(1.05)",
      };
    }
    // gradient: 4 evenly-distributed stops (0 / 33 / 66 / 100%).
    return {
      backgroundImage: `linear-gradient(to top, ${RAINBOW.join(", ")})`,
      filter: "saturate(1.35) brightness(1.05)",
    };
  };

  return (
    <div
      className={`flex items-center ${className ?? ""}`}
      style={{ gap, height: size, width: size }}
    >
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-full"
          style={{
            width: bar,
            height: "100%",
            transformOrigin: "center",
            animation: `dl-bar-wave-${i} 2.4s ease-in-out infinite`,
            ...barStyle(i),
          }}
        />
      ))}
    </div>
  );
}

function ConicRingSpinner({ size = 32, variant, className }: SpinnerProps) {
  const thickness = Math.max(2, size / 8);

  const bg =
    variant === "mono"
      ? `conic-gradient(from 0deg, transparent 0deg, ${THEME_COLOR.primary} 300deg, transparent 360deg)`
      : variant === "gradient"
        ? conicGradient([
            THEME_COLOR.primary,
            THEME_COLOR.done,
            THEME_COLOR.working,
            THEME_COLOR.done,
            THEME_COLOR.primary,
          ])
        : conicGradient([
            THEME_COLOR.primary,
            THEME_COLOR.done,
            THEME_COLOR.working,
            THEME_COLOR.waiting,
            THEME_COLOR.blocked,
            THEME_COLOR.primary,
          ]);

  return (
    <div
      className={`animate-spin rounded-full ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        background: bg,
        animationDuration: "1.4s",
        ...ringMaskStyle(size, thickness),
      }}
    />
  );
}

// -- Spinner registry ---------------------------------------------------------

interface SpinnerDef {
  id: string;
  label: string;
  description: string;
  Component: React.FC<SpinnerProps>;
}

const spinners: SpinnerDef[] = [
  {
    id: "conic-ring",
    label: "Conic Ring",
    description:
      "Solid ring filled with a rotating conic gradient. Shows every color at once — strongest for gradient / multi modes.",
    Component: ConicRingSpinner,
  },
  {
    id: "material-arc",
    label: "Material Arc",
    description:
      "Rotating circle whose stroke grows and shrinks — classic Material feel.",
    Component: MaterialArcSpinner,
  },
  {
    id: "dual-ring",
    label: "Dual Ring",
    description:
      "Two arcs counter-rotating at different speeds. Feels mechanical.",
    Component: DualRingSpinner,
  },
  {
    id: "orbit",
    label: "Orbit",
    description: "Three dots orbiting with trailing opacity. Playful, agent-y.",
    Component: OrbitSpinner,
  },
  {
    id: "pulse-dots",
    label: "Pulse Dots",
    description:
      "Staggered fade across three dots. Reads well inline in text like 'Loading…'.",
    Component: PulseDotsSpinner,
  },
  {
    id: "radar",
    label: "Radar Sweep",
    description:
      "Gradient arc sweeping a faded track. Feels like it's scanning for something.",
    Component: RadarSpinner,
  },
  {
    id: "activity-bars",
    label: "Activity Bars",
    description:
      "Wave travels right, bounces off the end, returns, rests. Considered, not urgent.",
    Component: ActivityBarsSpinner,
  },
];

// -- UI pieces ---------------------------------------------------------------

function SpinnerCell({
  def,
  variant,
}: {
  def: SpinnerDef;
  variant: ColorVariant;
}) {
  const { Component, label, description } = def;
  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-4">
      <div>
        <div className="text-sm font-semibold text-foreground">{label}</div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          {description}
        </p>
      </div>

      <div className="flex items-center justify-center rounded-lg bg-muted/40 p-6">
        <Component size={56} variant={variant} />
      </div>

      <div className="flex items-center justify-around rounded-lg bg-muted/25 p-3">
        <div className="flex flex-col items-center gap-1.5">
          <Component size={16} variant={variant} />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            sm
          </span>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <Component size={24} variant={variant} />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            md
          </span>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <Component size={40} variant={variant} />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            lg
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium">
          <Component size={14} variant={variant} />
          Loading
        </button>
        <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <Component size={14} variant={variant} />
          Loading jobs…
        </div>
      </div>
    </div>
  );
}

function IndeterminateBar({ variant }: { variant: ColorVariant }) {
  const background =
    variant === "mono"
      ? THEME_COLOR.primary
      : variant === "gradient"
        ? `linear-gradient(to right, ${THEME_COLOR.primary}, ${THEME_COLOR.done})`
        : `linear-gradient(to right, ${THEME_COLOR.primary}, ${THEME_COLOR.done}, ${THEME_COLOR.working}, ${THEME_COLOR.waiting})`;
  return (
    <div className="relative h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="absolute inset-y-0 left-0 w-1/3 rounded-full"
        style={{
          background,
          animation: "dl-indeterminate-bar 1.6s ease-in-out infinite",
        }}
      />
    </div>
  );
}

function ThemePicker({
  theme,
  setTheme,
}: {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1">
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

function VariantPicker({
  variant,
  setVariant,
}: {
  variant: ColorVariant;
  setVariant: (v: ColorVariant) => void;
}) {
  const options: { id: ColorVariant; label: string; hint: string }[] = [
    { id: "mono", label: "Mono", hint: "Primary color only" },
    { id: "gradient", label: "Gradient", hint: "Primary → Done" },
    { id: "multi", label: "Multi", hint: "All status colors" },
  ];
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1">
        Color
      </span>
      <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => setVariant(o.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              variant === o.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title={o.hint}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// -- Main page ---------------------------------------------------------------

export function DesignLab() {
  const { theme, setTheme } = useTheme();
  const [variant, setVariant] = useState<ColorVariant>("gradient");

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent =
      "html, body, #root { overflow: auto !important; height: auto !important; }" +
      SPINNER_KEYFRAMES;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-[1400px] mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">
            Loading Spinners
          </h1>
          <p className="text-sm text-muted-foreground">
            Candidate replacements for the current{" "}
            <code className="text-xs bg-muted rounded px-1 py-0.5">
              Loader2
            </code>{" "}
            spinner. Try different themes and color variants to find the
            combination that fits.
          </p>
        </header>

        <div className="sticky top-0 z-10 -mx-2 mb-8 rounded-xl border border-border bg-background/80 backdrop-blur px-4 py-3 flex items-center gap-6 flex-wrap">
          <ThemePicker theme={theme} setTheme={setTheme} />
          <VariantPicker variant={variant} setVariant={setVariant} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
          {spinners.map((def) => (
            <SpinnerCell key={def.id} def={def} variant={variant} />
          ))}
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3">
            <div className="text-sm font-semibold text-foreground">
              Indeterminate Bar
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Alternative for list/table loading states — a top-of-pane bar
              instead of a centered spinner.
            </p>
          </div>
          <IndeterminateBar variant={variant} />
        </div>
      </div>
    </div>
  );
}
