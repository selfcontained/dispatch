import { DesignLab } from "@/components/app/design-lab";
import { PageContent, PageHeader } from "@/components/ui/page-header";
import { SectionShell } from "./section-shell";

export function DesignLabRoute(): JSX.Element {
  return (
    <SectionShell>
      <PageHeader title="Design Lab" context="Defrag" />
      <PageContent>
        <DesignLab />
      </PageContent>
    </SectionShell>
  );
}
