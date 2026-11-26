export function ownedEnvironment(env: NodeJS.ProcessEnv): {
  marker: string;
  env: NodeJS.ProcessEnv;
};
export function killOwnedProcesses(marker: string): void;
export function ownedProcessPids(marker: string): number[];
