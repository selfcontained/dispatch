import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { SettingsGroup } from "@/components/app/settings-layout";
import { SettingRow } from "@/components/ui/setting-row";
import { LoadError } from "@/components/ui/async-boundary";

export function CertificateTrustSettings(): JSX.Element | null {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["certificate-trust"],
    queryFn: async (): Promise<{ available: boolean }> => {
      const response = await fetch("/api/v1/system/certificate-trust", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("The certificate setup check failed.");
      return response.json();
    },
    staleTime: 60_000,
  });

  if (error && !data)
    return (
      <LoadError
        thing="certificate setup"
        error={error}
        retrying={isFetching}
        onRetry={() => void refetch()}
      />
    );
  if (!data?.available) return null;

  return (
    <SettingsGroup title="Certificate trust">
      <SettingRow
        layout="action"
        label="Trust this server"
        description="Once on each device, to avoid certificate warnings. On iPhone and iPad, install the profile and enable full trust in Settings."
      >
        <Button asChild wrap>
          <a href="/trust">Set up certificate trust</a>
        </Button>
        <Button asChild wrap>
          <a href="/trust/dispatch.mobileconfig">
            Download Apple trust profile
          </a>
        </Button>
      </SettingRow>
    </SettingsGroup>
  );
}
