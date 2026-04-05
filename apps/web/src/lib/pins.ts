import type { AgentPin } from "../components/app/types";

export function splitPinValues(type: AgentPin["type"], value: string): string[] {
  if (type === "filename") {
    const parts = value.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [value];
  }

  if (type === "port") {
    const parts = value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [value];
  }

  return [value];
}
