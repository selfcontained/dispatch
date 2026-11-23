import { type ReactNode, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

import type { EngineLogin, EngineLoginEngine } from "@dispatch/shared";

import { Button } from "@/components/ui/button";
import { CommandBlock } from "@/components/ui/command-block";
import { Input } from "@/components/ui/input";
import { isLoginActive, useEngineLogin } from "@/hooks/use-engine-login";

/**
 * Sign an engine's CLI in on the server, in place. The server runs the
 * CLI's login and hands back its link, shown as text to copy rather than a
 * link to follow, so the person picks the browser (or device) it opens in.
 * Claude's sign-in page then shows a code that is pasted back here; Codex
 * shows a code to enter there and finishes by itself.
 *
 * Inline rather than a dialog, and read from the server rather than held
 * here: a reload, a second device or the row scrolling away and back all
 * find the login where it stands.
 */
export function EngineSignIn({
  engine,
  runnerId,
  since,
  onSignedIn,
  extra,
  primary = false,
}: {
  engine: EngineLoginEngine;
  runnerId?: string;
  /**
   * Only a login that ended after this shows how it ended (and fires
   * `onSignedIn`); an older one leaves the Sign in button. ISO time.
   * Absent, the latest login the server still has shows how it ended,
   * so a page that reloaded mid-sign-in still says it worked.
   */
  since?: string;
  /** Called once per login that succeeded after `since`. */
  onSignedIn?: (login: EngineLogin) => void;
  /** Shown beside Sign in while nothing is under way. */
  extra?: ReactNode;
  /** Sign in is the one primary action, as in a failed turn's Alert. */
  primary?: boolean;
}): JSX.Element {
  const flow = useEngineLogin(engine, runnerId);
  const { login } = flow;
  const [code, setCode] = useState("");
  const recent =
    !!login?.finishedAt && (since === undefined || login.finishedAt > since);

  const signedIn = login?.status === "succeeded" && recent ? login : null;
  const fired = useRef<string | null>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  useEffect(() => {
    if (!signedIn || fired.current === signedIn.id) return;
    fired.current = signedIn.id;
    onSignedInRef.current?.(signedIn);
  }, [signedIn]);

  const lead = primary
    ? ({ size: "sm", variant: "primary" } as const)
    : ({ size: "xs", variant: "secondary" } as const);
  const startOver = () => {
    setCode("");
    flow.start(true);
  };

  if (signedIn) {
    return (
      <p
        className="flex items-start gap-2 text-body-sm text-foreground"
        data-testid="engine-sign-in-done"
      >
        <CheckCircle2
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success"
          aria-hidden="true"
        />
        <span>Signed in{signedIn.detail ? ` (${signedIn.detail})` : ""}.</span>
      </p>
    );
  }

  const failed =
    (login?.status === "failed" && recent) ||
    (flow.error && !isLoginActive(login));
  if (failed) {
    return (
      <div className="space-y-2" data-testid="engine-sign-in-failed">
        <p role="alert" className="text-body-sm text-danger">
          {flow.error?.message ?? login?.error ?? "The sign-in failed."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            {...lead}
            onClick={startOver}
            disabled={flow.starting}
          >
            Start over
          </Button>
          {extra}
        </div>
      </div>
    );
  }

  if (!isLoginActive(login)) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          {...lead}
          onClick={() => flow.start()}
          disabled={flow.starting || !flow.loaded}
          data-testid="engine-sign-in-start"
        >
          {flow.starting ? "Starting…" : "Sign in"}
        </Button>
        {extra}
      </div>
    );
  }

  const cancel = (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      onClick={flow.cancel}
      data-testid="engine-sign-in-cancel"
    >
      Cancel
    </Button>
  );

  if (login?.status !== "waiting" || !login.url) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          role="status"
          className="flex items-center gap-2 text-body-sm text-muted-foreground"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {login?.status === "verifying"
            ? "Checking the code…"
            : "Starting the sign-in…"}
        </p>
        {cancel}
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-3" data-testid="engine-sign-in-steps">
      <div className="space-y-1.5">
        <p className="text-body-sm text-foreground">
          1. Copy this link and open it in a browser.
        </p>
        <CommandBlock
          text={login.url}
          testId="engine-sign-in-url"
          textClassName="break-all"
        />
      </div>
      {login.userCode ? (
        <div className="space-y-1.5">
          <p className="text-body-sm text-foreground">
            2. Sign in, then enter this code when asked.
          </p>
          <CommandBlock
            text={login.userCode}
            testId="engine-sign-in-user-code"
            textClassName="text-body-lg leading-7 tracking-widest"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-label-sm text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Waiting for you to finish in the browser…
            </p>
            {cancel}
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-body-sm text-foreground">
            2. Sign in, then paste the code the page shows.
          </p>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (code.trim()) flow.submitCode(code);
            }}
          >
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Paste code"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="Sign-in code"
              className="h-8 text-body-sm"
              data-testid="engine-sign-in-code"
            />
            <Button
              type="submit"
              size="sm"
              className="shrink-0 text-body-sm"
              disabled={!code.trim() || flow.submitting}
              data-testid="engine-sign-in-submit"
            >
              Sign in
            </Button>
          </form>
          <div className="flex justify-end">{cancel}</div>
        </div>
      )}
    </div>
  );
}
