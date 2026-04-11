import { type MouseEvent, type ReactNode } from "react";

import { getExternalBrowserHref, opensInExternalBrowser } from "@/lib/external-links";

type ExternalLinkProps = {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export function ExternalLink({ href, className, title, children, onClick }: ExternalLinkProps): JSX.Element {
  const externalHref = getExternalBrowserHref(href);
  const leavePwaShell = opensInExternalBrowser(href);

  return (
    <a
      href={externalHref}
      target={leavePwaShell ? undefined : "_blank"}
      rel={leavePwaShell ? undefined : "noopener noreferrer"}
      className={className}
      title={title}
      onClick={onClick}
    >
      {children}
    </a>
  );
}
