import { DesignLab } from "@/components/app/design-lab";
import { SectionShell } from "./section-shell";

export function DesignLabRoute(): JSX.Element {
  return (
    <SectionShell>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <DesignLab />
      </div>
    </SectionShell>
  );
}
