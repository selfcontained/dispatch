import * as React from "react";

import { errorStatus } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Alert } from "./alert";
import { LoadingSkeleton } from "./skeleton";

/** What AsyncBoundary reads of a React Query result. */
export type AsyncResult<T> = {
  data: T | undefined;
  error: unknown;
  isFetching: boolean;
  refetch: () => unknown;
};

/** A failed load, and the way to try it again. */
export function LoadError({
  thing,
  error,
  onRetry,
  retrying = false,
  className,
}: {
  /** What didn’t load, as it reads in "Couldn’t load <thing>." */
  thing: string;
  error?: unknown;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <Alert
      title={`Couldn’t load ${thing}.`}
      error={error}
      className={className}
      action={{ label: "Retry", onClick: onRetry, pending: retrying }}
    />
  );
}

/**
 * One region's query as exactly one of loading, error, empty or content.
 * Empty follows only a successful response. A failed refresh keeps what was
 * loaded, under the error.
 */
export function AsyncBoundary<T>({
  query,
  thing,
  loading,
  empty,
  isEmpty,
  notFound,
  className,
  children,
}: {
  query: AsyncResult<T>;
  thing: string;
  /** The skeleton, where rows aren’t the content’s shape. */
  loading?: React.ReactNode;
  empty?: React.ReactNode;
  isEmpty?: (data: T) => boolean;
  /** Shown only when the server says it doesn’t exist (404). */
  notFound?: React.ReactNode;
  /** Spaces the error and the default skeleton within their region. */
  className?: string;
  children: (data: T) => React.ReactNode;
}): JSX.Element {
  const { data, error, isFetching, refetch } = query;
  if (notFound && error && errorStatus(error) === 404) return <>{notFound}</>;

  const loaded = data !== undefined;
  const failure = error ? (
    <LoadError
      thing={thing}
      error={error}
      retrying={isFetching}
      onRetry={() => void refetch()}
      className={className}
    />
  ) : null;

  if (!loaded) {
    if (failure) return failure;
    return (
      <>
        {loading ?? (
          <LoadingSkeleton
            label={`Loading ${thing}…`}
            className={cn("w-auto", className)}
          />
        )}
      </>
    );
  }
  const showEmpty = empty !== undefined && isEmpty?.(data);
  return (
    <>
      {failure}
      {/* An empty result whose refresh failed is not known to be empty. */}
      {showEmpty ? (failure ? null : empty) : children(data)}
    </>
  );
}

/** Several queries that fill one region: loaded only once all of them are. */
export function combineResults(
  ...queries: AsyncResult<unknown>[]
): AsyncResult<true> {
  const failed = queries.filter((query) => query.error);
  return {
    data: queries.every((query) => query.data !== undefined) ? true : undefined,
    error: failed[0]?.error ?? null,
    isFetching: failed.some((query) => query.isFetching),
    refetch: () => failed.forEach((query) => void query.refetch()),
  };
}
