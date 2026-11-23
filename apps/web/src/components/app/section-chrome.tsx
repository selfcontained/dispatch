import { useMemo, type ReactNode } from "react";
import { PanelRightOpen } from "lucide-react";

import { NotificationsDrawer } from "@/components/app/notifications-drawer";
import { IconButton } from "@/components/ui/icon-button";
import {
  PageChromeContext,
  type PageChrome,
} from "@/components/ui/page-header";

/** The shell's part of every PageHeader: the sidebar's way back, and the bell. */
export function SectionChrome({
  leftPanelOpen,
  onOpenSidebar,
  trailing,
  children,
}: {
  leftPanelOpen: boolean;
  onOpenSidebar: () => void;
  /** After the bell. */
  trailing?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const chrome = useMemo<PageChrome>(
    () => ({
      leading: leftPanelOpen ? null : (
        <IconButton
          onClick={onOpenSidebar}
          label="Open sidebar"
          // It hides while the sidebar is open; the sheet finds it by this
          // to hand focus back.
          data-testid="open-sidebar"
        >
          <PanelRightOpen />
        </IconButton>
      ),
      trailing: (
        <>
          <NotificationsDrawer />
          {trailing}
        </>
      ),
    }),
    [leftPanelOpen, onOpenSidebar, trailing]
  );
  return (
    <PageChromeContext.Provider value={chrome}>
      {children}
    </PageChromeContext.Provider>
  );
}
