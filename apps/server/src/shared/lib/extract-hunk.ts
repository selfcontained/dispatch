export function extractHunkAroundLines(
  diffText: string,
  startLine: number,
  endLine: number
): string | null {
  const lines = diffText.split("\n");
  const result: string[] = [];
  let newLineNum = 0;
  let capturing = false;
  let insideHunk = false;
  let lastHunkHeader: string | null = null;
  let addedHunkHeader = false;

  for (const line of lines) {
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1]!, 10) - 1;
      lastHunkHeader = line;
      addedHunkHeader = false;
      capturing = false;
      insideHunk = true;
      continue;
    }

    if (!insideHunk) continue;

    if (line.startsWith("-")) {
      if (capturing) result.push(line);
      continue;
    }

    newLineNum++;
    const inRange = newLineNum >= startLine && newLineNum <= endLine;
    const inContext = newLineNum >= startLine - 3 && newLineNum <= endLine + 3;

    if (inContext) {
      if (!addedHunkHeader && lastHunkHeader) {
        result.push(lastHunkHeader);
        addedHunkHeader = true;
      }
      result.push(line);
    }

    if (inRange) capturing = true;
    if (newLineNum > endLine + 3 && capturing) break;
  }

  return result.length > 0 ? result.join("\n") : null;
}
