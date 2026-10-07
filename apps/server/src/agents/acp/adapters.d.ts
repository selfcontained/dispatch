/**
 * The adapters' CLI entries are plain JavaScript with no type declarations.
 * `main.ts` imports them for their side effect (each speaks ACP over stdio
 * and exits), so an empty module declaration is the whole contract. The
 * package's own `main` is not what we want: for the Claude adapter it is a
 * library that starts nothing.
 */
declare module "@agentclientprotocol/claude-agent-acp/dist/index.js";
declare module "@agentclientprotocol/codex-acp/dist/index.js";
