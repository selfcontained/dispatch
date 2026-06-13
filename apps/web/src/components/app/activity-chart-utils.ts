import { formatShortDate } from "@/lib/format";

export function formatDate(iso: string): string {
  return formatShortDate(iso);
}
