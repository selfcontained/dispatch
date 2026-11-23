/*
 * The agent host as the local runner child starts it: its entry point, its
 * launch file written from the launch request, and its ownership marker.
 * Kept apart from `host-command.ts`, which the host itself imports.
 */
import { childProcessEnv } from "../../shared/process/child-environment.js";
import {
  killOwnedProcesses,
  ownedEnvironment,
  ownedProcessPids,
} from "../../shared/process/owned-processes.js";
import { hostCommand, loginShellCommand } from "./host-command.js";
import { writeLocalHostLaunch } from "../local-runner.js";

/**
 * The agent host as the local runner child starts and identifies it (its
 * `posix-user` host entry): this binary's `agent-host` mode through the
 * user's login shell, with an ownership marker whose processes are cleaned
 * up after the host.
 */
export function localHostEntry() {
  return {
    command: () => hostCommand(),
    wrap: (command: string[]) => loginShellCommand(command),
    env: () => childProcessEnv(),
    prepare: writeLocalHostLaunch,
    ownership: {
      create: (env: NodeJS.ProcessEnv) => ownedEnvironment(env),
      cleanup: (marker: string) => killOwnedProcesses(marker),
      members: (marker: string) => ownedProcessPids(marker),
    },
  };
}
