import {
  Check,
  ChevronDown,
  ChevronUp,
  Chrome,
  Copy,
  Download,
  FolderOpen,
  Plus,
  Puzzle,
} from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type BrowserExtensionSetupCardProps = {
  connectionCount: number;
  showInstallGuide: boolean;
  setShowInstallGuide: Dispatch<SetStateAction<boolean>>;
  copiedUrl: boolean;
  onCopyUrl: (text: string) => void;
};

export function BrowserExtensionSetupCard({
  connectionCount,
  showInstallGuide,
  setShowInstallGuide,
  copiedUrl,
  onCopyUrl,
}: BrowserExtensionSetupCardProps): JSX.Element {
  const hasConnections = connectionCount > 0;
  const dispatchUrl = window.location.origin;

  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3 space-y-0">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <Chrome className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <CardTitle className="text-base">
            {hasConnections
              ? "Dispatch Browser Feedback"
              : "Try browser feedback"}
          </CardTitle>
          <CardDescription>
            {hasConnections
              ? `${connectionCount} ${connectionCount === 1 ? "browser is" : "browsers are"} paired and ready to send selected page context.`
              : "Select an element on any web app, add a comment, and send both directly to an agent."}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasConnections && (
          <div className="flex flex-wrap gap-2">
            <Button
              asChild
              variant="primary"
              onClick={() => setShowInstallGuide(true)}
            >
              <a href="/dispatch-browser-feedback.zip" download>
                <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                Download extension ZIP
              </a>
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowInstallGuide((visible) => !visible)}
              aria-expanded={showInstallGuide}
            >
              {showInstallGuide ? "Hide setup" : "Already downloaded?"}
              {showInstallGuide ? (
                <ChevronUp className="ml-2 h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="ml-2 h-4 w-4" aria-hidden="true" />
              )}
            </Button>
          </div>
        )}
        {hasConnections && (
          <Button
            type="button"
            variant="default"
            onClick={() => setShowInstallGuide((visible) => !visible)}
            aria-expanded={showInstallGuide}
          >
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Add another browser
          </Button>
        )}

        {showInstallGuide && (
          <div
            className="space-y-4 rounded-lg border border-border bg-background/40 p-4"
            data-testid="extension-install-guide"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-[1_1_16rem]">
                <p className="text-sm font-medium">Finish setup in Chrome</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  The extension is a developer preview, so Chrome loads it from
                  an unzipped folder for now.
                </p>
              </div>
              {hasConnections && (
                <Button asChild variant="primary" size="sm">
                  <a href="/dispatch-browser-feedback.zip" download>
                    <Download className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                    Download ZIP
                  </a>
                </Button>
              )}
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
              <div className="min-w-0 rounded-lg border border-border p-3">
                <FolderOpen
                  className="mb-2 h-4 w-4 text-primary"
                  aria-hidden="true"
                />
                <p className="text-sm font-medium">1. Unzip the download</p>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  Keep the extracted folder somewhere Chrome can continue to
                  access it.
                </p>
              </div>
              <div className="min-w-0 rounded-lg border border-border p-3">
                <Puzzle
                  className="mb-2 h-4 w-4 text-primary"
                  aria-hidden="true"
                />
                <p className="text-sm font-medium">2. Load the folder</p>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  Open <code className="break-all">chrome://extensions</code>,
                  enable Developer mode, then choose Load unpacked.
                </p>
              </div>
              <div className="min-w-0 rounded-lg border border-border p-3">
                <Chrome
                  className="mb-2 h-4 w-4 text-primary"
                  aria-hidden="true"
                />
                <p className="text-sm font-medium">3. Connect Dispatch</p>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  Open the extension, enter this Dispatch URL, and verify the
                  pairing code here.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-xs">
                {dispatchUrl}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => onCopyUrl(dispatchUrl)}
                aria-label="Copy Dispatch URL"
              >
                {copiedUrl ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span className="ml-1.5">{copiedUrl ? "Copied" : "Copy"}</span>
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
