import { DayPicker } from "react-day-picker";
import { cn } from "@/lib/utils";

function Calendar({
  className,
  classNames,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-2",
        month: "flex flex-col gap-4",
        month_caption: "flex justify-center pt-1 relative items-center text-sm font-medium",
        caption_label: "text-sm font-medium",
        nav: "flex items-center gap-1",
        button_previous:
          "absolute left-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md bg-accent text-muted-foreground p-0 hover:bg-accent/80 hover:text-foreground transition-colors",
        button_next:
          "absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md bg-accent text-muted-foreground p-0 hover:bg-accent/80 hover:text-foreground transition-colors",
        month_grid: "w-full border-collapse space-x-1",
        weekdays: "flex",
        weekday:
          "text-muted-foreground rounded-md w-8 font-normal text-[0.8rem]",
        week: "flex w-full mt-2",
        day: "relative p-0 text-center text-sm focus-within:relative focus-within:z-20",
        day_button:
          "inline-flex h-8 w-8 items-center justify-center rounded-md p-0 font-normal hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-selected:opacity-100",
        selected:
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground [&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground",
        today: "bg-accent text-accent-foreground rounded-md",
        outside:
          "text-muted-foreground opacity-50 aria-selected:bg-accent/50 aria-selected:text-muted-foreground aria-selected:opacity-30",
        disabled: "text-muted-foreground opacity-50",
        hidden: "invisible",
        ...classNames,
      }}
      {...props}
    />
  );
}
Calendar.displayName = "Calendar";

export { Calendar };
