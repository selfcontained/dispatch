import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

export function CertificateTrustSettings(): JSX.Element | null {
  const { data } = useQuery({
    queryKey: ["certificate-trust"],
    queryFn: async (): Promise<{ available: boolean }> => {
      const response = await fetch("/api/v1/system/certificate-trust", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not check certificate setup.");
      return response.json();
    },
    staleTime: 60_000,
  });

  if (!data?.available) return null;

  return (
    <section aria-labelledby="certificate-trust-heading">
      <h3
        id="certificate-trust-heading"
        className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Certificate trust
      </h3>
      <p className="mb-4 max-w-lg text-sm text-muted-foreground">
        Trust this Dispatch server once on each device to avoid certificate
        warnings. On iPhone and iPad, install the profile and enable full trust
        in Settings.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          asChild
          className="h-auto min-h-9 whitespace-normal text-center"
        >
          <a href="/trust">Set up certificate trust</a>
        </Button>
        <Button
          asChild
          className="h-auto min-h-9 whitespace-normal text-center"
        >
          <a href="/trust/dispatch.mobileconfig">
            Download Apple trust profile
          </a>
        </Button>
      </div>
    </section>
  );
}
