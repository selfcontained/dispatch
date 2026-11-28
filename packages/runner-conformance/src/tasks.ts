import type { OpName } from "@dispatch/runner-protocol/contract";

/**
 * The task that implements each operation for real: it moves the family into
 * the runner program and adds the family's scenarios. A red baseline entry
 * names the task that turns it green.
 */
export const OPERATION_TASK = {
  "runner.describe": "L1",
  "runner.health": "L1",
  "session.launch": "T23",
  "session.attach": "T23",
  "session.alive": "T23",
  "session.stop": "T26",
  "session.discard": "T26",
  "session.retire": "T26",
  "session.logs": "T23",
  "session.list": "T27",
  "session.sample": "T27",
  "terminal.open": "T21",
  "workspace.prepare": "T18",
  "workspace.resume": "T26",
  "workspace.describe": "T16",
  "workspace.select": "T16",
  "workspace.observe": "T16",
  "workspace.release": "T20",
  "path.resolve": "T17",
  "path.complete": "T40",
  "git.remoteHeads": "T40",
  "checkout.list": "T40", // Native folder definition enumeration; original views T09.
  "checkout.access": "T40", // F_OK presence, with native error details.
  "checkout.read": "T40", // Owned checkout, native definitions and command-manifest guards. Original reads T09.
  "checkout.write": "T35",
  "checkout.preview": "T09",
  "checkout.index": "T09",
  "checkout.stats": "T09",
  "checkout.diff": "T09",
  "checkout.image": "T09",
  "checkout.changes": "T09",
  "checkout.defaultFiles": "T09",
  "checkout.watch": "T09",
  "checkout.exec": "T40", // Resolved directory guard; existing manifest digest guard T14.
  "files.put": "T12",
  "files.get": "T11",
  "git.context": "T15",
  "git.defaultBranch": "T16",
  "git.branches": "T16",
  "git.origin": "T40",
  "git.roots": "T40", // Includes the independent checkoutOnly probe; default roots stay unchanged.
  "git.base": "T16",
  "github.account": "T32",
  "github.login.start": "T32",
  "github.login.cancel": "T32",
  "github.logout": "T32",
  "github.repositories": "T32",
  "github.branches": "T32",
  "github.pr.head": "T40",
  "github.pr.status": "T32",
  "github.pr.details": "T33",
  "github.pr.diff": "T33",
  // Background inventory yields to a protected update; explicit lists remain available.
  "engine.list": "T28",
  "engine.install": "T29",
  "engine.update": "T29",
  "engine.update.inspect": "T29",
  "engine.update.spawn": "T29",
  "engine.update.release": "T29",
  "engine.update.probe": "T29",
  "engine.operation": "T29",
  "engine.login.start": "T28",
  "engine.login.submit": "T28",
  "engine.login.status": "T28",
  "engine.login.cancel": "T28",
  "engine.models": "T30",
  "engine.usage": "T31",
  "engine.quota.reset": "T31",
  "engine.plugin.status": "T29",
  "engine.plugin.apply": "T29",
  "port.connect": "T39",
  "update.offer": "L3",
  "update.fence": "L3",
  "update.activate": "L3",
  "update.confirm": "L3",
  "update.cancel": "L3",
} as const satisfies Record<OpName, string>;

/** Overrides for operations whose scenarios are owned by a separate task. */
export const SCENARIO_TASK: Partial<Record<OpName, string>> = {};
