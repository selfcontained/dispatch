import { CornerDownLeft, Keyboard, Sparkles, Waves } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { THEMES, useTheme, type ThemeId } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

// Canvas for one-off component experiments. Add sections below as needed and
// remove them once the work ships — this page intentionally stays empty
// between projects so it's always ready for the next variant exploration.

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

type FeedbackConcept = {
  id: "halo" | "sweep" | "chip";
  badge: string;
  title: string;
  description: string;
  rationale: string;
  effectLabel: string;
  accentClass: string;
};

const FEEDBACK_CONCEPTS: FeedbackConcept[] = [
  {
    id: "halo",
    badge: "Low noise",
    title: "Halo Pulse",
    description:
      "A soft ring blooms around Enter and fades quickly, so the tap reads without cluttering the rest of the keyboard.",
    rationale:
      "Best when the reinforcement should feel premium and quiet, especially for repeated command entry.",
    effectLabel: "Tap confirmed",
    accentClass: "from-cyan-400/70 via-sky-300/35 to-transparent",
  },
  {
    id: "sweep",
    badge: "Directional",
    title: "Signal Sweep",
    description:
      "A bright seam races into Enter, making the action feel like a command being pushed forward into the terminal.",
    rationale:
      "Best when the keyboard should feel connected to the terminal transport instead of just being a button deck.",
    effectLabel: "Command sent",
    accentClass: "from-amber-300/85 via-orange-300/60 to-transparent",
  },
  {
    id: "chip",
    badge: "Explicit",
    title: "Confirmation Chip",
    description:
      "A tiny chip lifts off the key with a terse label so silent-mode users get a stronger acknowledgment on each tap.",
    rationale:
      "Best when the action should be unmistakable, or when the sound cue is doing real confirmation work today.",
    effectLabel: "New line",
    accentClass: "from-emerald-300/80 via-lime-300/45 to-transparent",
  },
];

function KeyCap({
  label,
  wide = false,
  onClick,
  children,
  className,
  testId,
}: {
  label: string;
  wide?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const classes = cn(
    "relative flex items-center justify-center rounded-[1.75rem] border border-white/10 bg-white/[0.05] px-4 py-4 text-lg font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.32)] transition-transform duration-150",
    wide ? "min-h-[6.5rem] w-[8.2rem]" : "min-h-[4.3rem] w-[4.7rem]",
    onClick && "active:scale-[0.98]",
    className
  );

  if (!onClick) {
    return (
      <div aria-hidden="true" data-testid={testId} className={classes}>
        <span className="relative z-10">{label}</span>
        {children}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={classes}
    >
      <span className="relative z-10">{label}</span>
      {children}
    </button>
  );
}

function FeedbackDemo({ concept }: { concept: FeedbackConcept }) {
  const [tapCount, setTapCount] = useState(0);
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    if (!pressed) return;
    const timeout = window.setTimeout(() => setPressed(false), 180);
    return () => window.clearTimeout(timeout);
  }, [pressed]);

  const trigger = () => {
    setTapCount((value) => value + 1);
    setPressed(true);
  };

  return (
    <Card className="overflow-hidden border border-border/70 bg-card/70">
      <CardHeader className="gap-3 border-b border-border/60">
        <div className="flex items-center justify-between gap-3">
          <Badge variant="default">{concept.badge}</Badge>
          <button
            type="button"
            onClick={trigger}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Replay cue
          </button>
        </div>
        <div className="space-y-1">
          <CardTitle>{concept.title}</CardTitle>
          <CardDescription>{concept.description}</CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-4">
        <div className="overflow-hidden rounded-[2rem] border border-white/8 bg-[#0a0c11] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="mx-auto h-[16rem] w-full max-w-[22rem] overflow-visible sm:h-auto">
            <div className="w-fit origin-top scale-[0.67] sm:scale-[0.8] md:scale-100">
              <div className="mb-4 rounded-[1.4rem] border border-white/8 bg-[radial-gradient(circle_at_30%_0%,rgba(87,132,255,0.14),transparent_45%),linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.01))] p-3">
                <div className="flex items-center gap-2 text-xs text-white/60">
                  <Keyboard className="h-3.5 w-3.5" />
                  Mobile shortcut keys
                </div>
                <div className="mt-3 h-20 rounded-[1.2rem] border border-white/8 bg-black/25" />
              </div>

              <div className="grid grid-cols-[1.15fr_2fr_1.15fr] gap-3">
                <KeyCap label="" wide className="justify-center">
                  <Keyboard className="h-7 w-7 text-white/90" strokeWidth={2} />
                </KeyCap>

                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <KeyCap label="Esc" className="min-h-[4rem]" />
                    <KeyCap label="Ctrl" className="min-h-[4rem]" />
                    <KeyCap label="Tab" className="min-h-[4rem]" />
                  </div>
                  <div className="grid grid-cols-4 gap-3">
                    <KeyCap label="←" className="min-h-[4rem]" />
                    <KeyCap label="↑" className="min-h-[4rem]" />
                    <KeyCap label="↓" className="min-h-[4rem]" />
                    <KeyCap label="→" className="min-h-[4rem]" />
                  </div>
                </div>

                <KeyCap
                  label="Enter"
                  wide
                  onClick={trigger}
                  testId={`enter-feedback-${concept.id}`}
                  className={cn(
                    "overflow-visible",
                    pressed &&
                      "scale-[0.985] border-white/20 bg-white/[0.09] shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_0_0_1px_rgba(255,255,255,0.08),0_14px_36px_rgba(0,0,0,0.4)]"
                  )}
                >
                  {tapCount > 0 ? (
                    <>
                      {concept.id === "halo" ? (
                        <>
                          <span
                            key={`halo-ring-${tapCount}`}
                            className="pointer-events-none absolute -inset-2 rounded-[2rem] border border-cyan-300/70 animate-[design-lab-halo_680ms_cubic-bezier(0.16,1,0.3,1)]"
                          />
                          <span
                            key={`halo-glow-${tapCount}`}
                            className="pointer-events-none absolute -inset-3 rounded-[2.4rem] bg-cyan-300/20 blur-xl animate-[design-lab-glow_680ms_ease-out]"
                          />
                        </>
                      ) : null}

                      {concept.id === "sweep" ? (
                        <span
                          key={`sweep-${tapCount}`}
                          className={cn(
                            "pointer-events-none absolute left-[-7rem] top-1/2 h-2 w-28 -translate-y-1/2 rounded-full bg-gradient-to-r blur-[1px] animate-[design-lab-sweep_760ms_cubic-bezier(0.16,1,0.3,1)]",
                            concept.accentClass
                          )}
                        />
                      ) : null}

                      {concept.id === "chip" ? (
                        <span
                          key={`chip-${tapCount}`}
                          className="pointer-events-none absolute -top-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-emerald-300/35 bg-emerald-300/16 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-100 animate-[design-lab-chip_820ms_cubic-bezier(0.16,1,0.3,1)]"
                        >
                          {concept.effectLabel}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </KeyCap>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-2xl border border-border/60 bg-background/40 px-4 py-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <CornerDownLeft className="h-4 w-4 text-muted-foreground" />
              {concept.effectLabel}
            </div>
            <p className="text-sm text-muted-foreground">{concept.rationale}</p>
          </div>
          <div
            className="text-right text-xs text-muted-foreground"
            data-testid={`feedback-count-${concept.id}`}
          >
            {tapCount} preview taps
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function DesignLab() {
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `
      html, body, #root { overflow: auto !important; height: auto !important; }

      @keyframes design-lab-halo {
        0% { opacity: 0.9; transform: scale(0.92); }
        100% { opacity: 0; transform: scale(1.12); }
      }

      @keyframes design-lab-glow {
        0% { opacity: 0.5; transform: scale(0.96); }
        100% { opacity: 0; transform: scale(1.18); }
      }

      @keyframes design-lab-sweep {
        0% { opacity: 0; transform: translate(-3.5rem, -50%) scaleX(0.72); }
        20% { opacity: 1; }
        100% { opacity: 0; transform: translate(14rem, -50%) scaleX(1.08); }
      }

      @keyframes design-lab-chip {
        0% { opacity: 0; transform: translate(-50%, 0.5rem) scale(0.92); }
        15% { opacity: 1; transform: translate(-50%, -0.1rem) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -1.5rem) scale(1); }
      }
    `;
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
            Design Lab
          </h1>
          <p className="text-sm text-muted-foreground">
            Sandbox for previewing component variations against different
            themes.
          </p>
        </header>

        <div className="sticky top-0 z-10 -mx-2 mb-8 rounded-xl border border-border bg-background/80 backdrop-blur px-4 py-3 flex items-center gap-6 flex-wrap">
          <ThemePicker theme={theme} setTheme={setTheme} />
        </div>

        <section className="space-y-6" data-testid="silent-tap-feedback-lab">
          <div className="max-w-3xl space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
              <Waves className="h-3.5 w-3.5" />
              Silent-mode reinforcement
            </div>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              Mobile Enter feedback studies
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              These concepts keep the current shortcut-key layout but give the
              Enter tap a visual confirmation that can stand in for the audio
              cue when the phone is muted. Each demo is clickable so the
              response can be judged for intensity, clarity, and taste across
              themes.
            </p>
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            {FEEDBACK_CONCEPTS.map((concept) => (
              <FeedbackDemo key={concept.id} concept={concept} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
