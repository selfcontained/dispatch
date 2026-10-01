/**
 * Plain names in the current tree keep their existing meaning. External
 * sessions whose names collide need an explicit identity in their token;
 * otherwise a picker selection would be lost when only the text is sent.
 */
export function qualifyExternalMentions<T extends { id: string; name: string }>(
  tree: readonly T[],
  external: readonly T[]
): Array<T & { mentionName?: string; qualifiedMentionName: string }> {
  const normalize = (name: string) => name.trim().toLowerCase();
  const names = new Map<string, number>();
  for (const agent of external) {
    const name = normalize(agent.name);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const treeNames = tree.map((agent) => normalize(agent.name)).filter(Boolean);
  return external.map((agent) => {
    const name = normalize(agent.name);
    const overlapsTree = treeNames.some((treeName) => {
      if (!name.startsWith(treeName)) return false;
      const next = name.slice(treeName.length);
      return !next || /^[^\p{L}\p{N}_]/u.test(next);
    });
    const qualifiedMentionName = `${agent.name.trim()} [${agent.id}]`;
    return {
      ...agent,
      qualifiedMentionName,
      ...(names.get(name)! > 1 || overlapsTree
        ? { mentionName: qualifiedMentionName }
        : {}),
    };
  });
}
