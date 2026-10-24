import { useLayoutEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useAuthContext } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SetPasswordForm } from "./set-password-form";

export function ExposureBanner() {
  const { exposed } = useAuthContext();
  const [open, setOpen] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const banner = bannerRef.current;
    const shell = banner?.parentElement;
    if (!banner || !shell) return;
    // Floating drawers inherit this offset; keep their tabs and the banner's
    // action reachable even when the warning wraps or safe-area padding changes.
    const measure = () =>
      shell.style.setProperty(
        "--exposure-banner-height",
        `${banner.getBoundingClientRect().height}px`
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(banner);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--exposure-banner-height");
    };
  }, [exposed]);
  if (!exposed) return null;

  return (
    <div
      ref={bannerRef}
      role="alert"
      className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top,0px))] text-sm text-amber-600 dark:text-amber-300"
    >
      <ShieldAlert className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        Anyone on your network can control Dispatch. Set a password.
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="default" className="shrink-0">
            Set password
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set a Dispatch password</DialogTitle>
            <DialogDescription>
              Require a password to control Dispatch from your network.
            </DialogDescription>
          </DialogHeader>
          <SetPasswordForm onSuccess={() => setOpen(false)} />
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
