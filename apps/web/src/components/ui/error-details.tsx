/** The server's own words, behind a disclosure. */
export function ErrorDetails({
  message,
  onToggle,
}: {
  message: string;
  onToggle?: () => void;
}): JSX.Element {
  return (
    <details className="text-body-sm" onToggle={onToggle}>
      <summary className="w-fit cursor-pointer select-none rounded-sm py-0.5 text-muted-foreground hover:text-foreground focus-ring pointer-coarse:min-h-11 pointer-coarse:py-3">
        Details
      </summary>
      <p className="max-h-32 select-text overflow-y-auto whitespace-pre-line break-words text-muted-foreground">
        {message}
      </p>
    </details>
  );
}
