import { CornerDownLeft, Sparkles, Waves } from "lucide-react";
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
  id: "halo-crisp" | "halo-soft" | "halo-edge";
  badge: string;
  title: string;
  description: string;
  rationale: string;
  effectLabel: string;
  effectKind: "outline" | "wash" | "surface";
  effectClass: string;
  stageClass: string;
};

const FEEDBACK_CONCEPTS: FeedbackConcept[] = [
  {
    id: "halo-crisp",
    badge: "Crisp",
    title: "Crisp Halo",
    description:
      "A single bright ring snaps on and fades quickly, keeping the feedback precise and readable.",
    rationale:
      "Best when the callout should feel exact and intentional without a lot of haze around the key.",
    effectLabel: "Tap confirmed",
    effectKind: "outline",
    effectClass: "border-cyan-300/80",
    stageClass:
      "bg-[radial-gradient(circle_at_50%_20%,rgba(81,144,255,0.12),transparent_46%),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))]",
  },
  {
    id: "halo-soft",
    badge: "Soft",
    title: "Soft Halo",
    description:
      "A single soft wash blooms around the key and fades, making the tap feel warmer and more atmospheric.",
    rationale:
      "Best when the visual confirmation should read more premium and ambient than sharp or technical.",
    effectLabel: "Tap confirmed",
    effectKind: "wash",
    effectClass: "bg-sky-200/20",
    stageClass:
      "bg-[radial-gradient(circle_at_50%_15%,rgba(146,219,255,0.16),transparent_48%),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))]",
  },
  {
    id: "halo-edge",
    badge: "Subtle",
    title: "Edge Halo",
    description:
      "The key face itself flashes with a cool edge-light, so the feedback feels integrated instead of floating outside the button.",
    rationale:
      "Best when the treatment should stay contained to the key and avoid a separate halo shape around it.",
    effectLabel: "Tap confirmed",
    effectKind: "surface",
    effectClass:
      "bg-[linear-gradient(180deg,rgba(190,240,255,0.2),rgba(190,240,255,0.05))] shadow-[inset_0_0_0_1px_rgba(190,240,255,0.22),0_0_30px_rgba(100,190,255,0.12)]",
    stageClass:
      "bg-[radial-gradient(circle_at_50%_20%,rgba(120,198,255,0.08),transparent_46%),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))]",
  },
];

function KeyCap({
  label,
  onClick,
  children,
  className,
  testId,
}: {
  label: string;
  onClick?: () => void;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const classes = cn(
    "relative flex w-full items-center justify-center rounded-[1.5rem] border border-white/10 bg-white/[0.05] px-3 py-3 text-base font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.32)] sm:rounded-[1.75rem] sm:px-4 sm:py-4 sm:text-lg",
    "min-h-[5rem] sm:min-h-[6.5rem]",
    onClick && "cursor-pointer",
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
  const [effectRun, setEffectRun] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (effectRun === 0) return;
    const timeout = window.setTimeout(() => setEffectRun(0), 900);
    return () => window.clearTimeout(timeout);
  }, [effectRun]);

  const trigger = (source: "enter" | "replay") => {
    setTapCount((value) => {
      const next = value + 1;
      setAnnouncement(
        `${concept.effectLabel}. ${source === "replay" ? "Replay cue." : "Enter pressed."} ${next} preview taps.`
      );
      return next;
    });
    setEffectRun(Date.now());
  };

  return (
    <Card className="overflow-hidden border border-border/70 bg-card/70">
      <CardHeader className="gap-3 border-b border-border/60">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge variant="default">{concept.badge}</Badge>
          <button
            type="button"
            onClick={() => trigger("replay")}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            data-testid={`replay-cue-${concept.id}`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Replay cue
          </button>
        </div>
        <div
          className="sr-only"
          aria-live="polite"
          aria-atomic="true"
          data-testid={`feedback-live-${concept.id}`}
        >
          {announcement}
        </div>
        <div className="space-y-1">
          <CardTitle>{concept.title}</CardTitle>
          <CardDescription>{concept.description}</CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-4">
        <div className="overflow-hidden rounded-[2rem] border border-white/8 bg-[#0a0c11] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="mx-auto w-full max-w-[22rem] overflow-visible">
            <div className="mb-4 rounded-[1.25rem] border border-white/8 bg-[radial-gradient(circle_at_30%_0%,rgba(87,132,255,0.14),transparent_45%),linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.01))] p-3 sm:rounded-[1.4rem]">
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/50 sm:text-xs">
                Enter key feedback
              </div>
              <div className="mt-3 h-16 rounded-[1rem] border border-white/8 bg-black/25 sm:h-20 sm:rounded-[1.2rem]" />
            </div>

            <div
              className={cn(
                "rounded-[1.75rem] border border-white/8 px-5 py-6 sm:px-6 sm:py-7",
                concept.stageClass
              )}
            >
              <div className="mx-auto max-w-[12rem]">
                <div className="mb-3 text-center text-xs uppercase tracking-[0.2em] text-white/45">
                  Tap target
                </div>
                <KeyCap
                  label="Enter"
                  onClick={() => trigger("enter")}
                  testId={`enter-feedback-${concept.id}`}
                  className="overflow-visible min-h-[6rem] rounded-[1.9rem] text-lg sm:min-h-[7rem] sm:rounded-[2.1rem] sm:text-xl"
                >
                  {effectRun !== 0 ? (
                    concept.effectKind === "outline" ? (
                      <span
                        key={`outline-${effectRun}`}
                        data-testid={`effect-outline-${concept.id}`}
                        className={cn(
                          "pointer-events-none absolute -inset-2 rounded-[1.9rem] border opacity-0 animate-[design-lab-halo_680ms_cubic-bezier(0.16,1,0.3,1)] [animation-fill-mode:forwards] sm:rounded-[2rem]",
                          concept.effectClass
                        )}
                      />
                    ) : concept.effectKind === "wash" ? (
                      <span
                        key={`wash-${effectRun}`}
                        data-testid={`effect-wash-${concept.id}`}
                        className={cn(
                          "pointer-events-none absolute -inset-4 rounded-[2.4rem] opacity-0 blur-2xl animate-[design-lab-glow_720ms_ease-out] [animation-fill-mode:forwards] sm:rounded-[2.8rem]",
                          concept.effectClass
                        )}
                      />
                    ) : (
                      <span
                        key={`surface-${effectRun}`}
                        data-testid={`effect-surface-${concept.id}`}
                        className={cn(
                          "pointer-events-none absolute inset-0 rounded-[1.9rem] opacity-0 animate-[design-lab-surface_620ms_ease-out] [animation-fill-mode:forwards] sm:rounded-[2.1rem]",
                          concept.effectClass
                        )}
                      />
                    )
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
        0% { opacity: 0.95; }
        100% { opacity: 0; }
      }

      @keyframes design-lab-glow {
        0% { opacity: 0.5; }
        100% { opacity: 0; }
      }

      @keyframes design-lab-surface {
        0% { opacity: 0; }
        18% { opacity: 1; }
        100% { opacity: 0; }
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
