import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { useTouchPhone } from "@/hooks/use-coarse-pointer";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./dropdown-menu";
import { RowButton } from "./row-button";
import { Sheet, SheetHeader } from "./sheet";

const MenuContext = React.createContext({
  phone: false,
  open: false,
  setOpen: (_open: boolean) => {},
  label: "Actions",
  title: "Actions" as React.ReactNode,
});

/** One action list: a bottom sheet on touch phones, an anchored dropdown elsewhere. */
export function ActionMenu({
  label,
  title = label,
  open: controlled,
  onOpenChange,
  children,
}: {
  label: string;
  title?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const phone = useTouchPhone();
  const [localOpen, setLocalOpen] = React.useState(false);
  const open = controlled ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  return (
    <MenuContext.Provider value={{ phone, open, setOpen, label, title }}>
      {phone ? (
        children
      ) : (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          {children}
        </DropdownMenu>
      )}
    </MenuContext.Provider>
  );
}

export function ActionMenuTrigger(
  props: React.ComponentPropsWithoutRef<typeof DropdownMenuTrigger>
) {
  const { phone, open, setOpen } = React.useContext(MenuContext);
  if (!phone) return <DropdownMenuTrigger {...props} />;
  const { asChild, onClick, ...rest } = props;
  const Component = asChild ? Slot : "button";
  return (
    <Component
      {...rest}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-state={open ? "open" : "closed"}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (!event.defaultPrevented) setOpen(!open);
      }}
    />
  );
}

export function ActionMenuContent({
  children,
  className,
  onCloseAutoFocus,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuContent> & {
  "data-agent-control"?: string;
}) {
  const { phone, open, setOpen, label, title } = React.useContext(MenuContext);
  if (!phone)
    return (
      <DropdownMenuContent
        className={className}
        onCloseAutoFocus={onCloseAutoFocus}
        {...props}
      >
        {children}
      </DropdownMenuContent>
    );
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      keepMounted={false}
      label={label}
    >
      <SheetHeader title={title} onClose={() => setOpen(false)} />
      <div
        className="flex flex-col overflow-y-auto px-2 pb-[max(env(safe-area-inset-bottom),12px)] pt-1"
        data-agent-control={props["data-agent-control"]}
      >
        {children}
      </div>
    </Sheet>
  );
}

export function ActionMenuItem({
  onSelect,
  className,
  children,
  ...props
}: Pick<
  React.ComponentPropsWithoutRef<typeof DropdownMenuItem>,
  | "children"
  | "onSelect"
  | "className"
  | "disabled"
  | "title"
  | "id"
  | "aria-label"
  | "aria-describedby"
> & { "data-testid"?: string }) {
  const { phone, setOpen } = React.useContext(MenuContext);
  if (!phone)
    return (
      <DropdownMenuItem onSelect={onSelect} className={className} {...props}>
        {children}
      </DropdownMenuItem>
    );
  return (
    <RowButton
      dense
      {...props}
      className={cn(
        "min-h-12 px-3 py-2 text-foreground [&>svg]:size-icon-md",
        className
      )}
      onClick={() => {
        const event = new Event("select", { cancelable: true });
        onSelect?.(event);
        if (!event.defaultPrevented) setOpen(false);
      }}
    >
      {children}
    </RowButton>
  );
}

export function ActionMenuSeparator() {
  const { phone } = React.useContext(MenuContext);
  return phone ? (
    <div role="separator" className="my-1 border-t border-border-subtle" />
  ) : (
    <DropdownMenuSeparator />
  );
}
