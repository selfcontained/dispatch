import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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
        className="max-w-lg"
      />
    );
  if (!data?.available) return null;

  return (
    <section aria-labelledby="certificate-trust-heading">
      <h3 id="certificate-trust-heading" className="mb-4 section-label">
        Certificate trust
      </h3>
      <p className="mb-4 max-w-lg text-body-md text-muted-foreground">
        Trust this Dispatch server once on each device to avoid certificate
        warnings. On iPhone and iPad, install the profile and enable full trust
        in Settings.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button asChild wrap>
          <a href="/trust">Set up certificate trust</a>
        </Button>
        <Button asChild wrap>
          <a href="/trust/dispatch.mobileconfig">
            Download Apple trust profile
          </a>
        </Button>
      </div>
    </section>
  );
}
