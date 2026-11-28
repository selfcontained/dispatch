import { FieldError } from "@/components/ui/field";
import { Button } from "@/components/ui/button";

export function LaunchTargetError({
  queries,
}: {
  queries: {
    isError: boolean;
    error: Error | null;
    refetch: () => Promise<unknown>;
  }[];
}) {
  const failed = queries.find((query) => query.isError);
  return failed ? (
    <FieldError>
      {failed.error?.message}{" "}
      <Button
        type="button"
        variant="link"
        size="inline"
        onClick={() => void failed.refetch()}
      >
        Retry
      </Button>
    </FieldError>
  ) : null;
}
