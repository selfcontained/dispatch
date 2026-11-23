import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  archiveReleaseRestriction,
  restrictionHits,
} from "./runner-restrictions.mjs";

const tsNodeBuiltins = new Set(builtinModules);

const server = "apps/server/src/";
const web = "apps/web/src/";
const baselinePath = "scripts/runner-boundary-baseline.json";
const packages = [
  "runner-protocol",
  "runner-client",
  "runner",
  "runner-conformance",
];
const machine = server + "runners/controller-machine";
const machineExports = new Set([
  "identityKey",
  "blobSource",
  "previewUrl",
  "ideTarget",
]);

// Capabilities are limited to the resources Dispatch owns in each location.
const ownMachine = [
  [/^runners\/controller-machine\.ts$/, "fs", "controller blob paths"],
  [/^runners\/enrolled\//, "fs", "listener keys"],
  [/^db\//, "fs", "Dispatch database and migrations"],
  [
    /^(update-recovery\/|server\/update-recovery-runtime\.ts$)/,
    "fs process",
    "Dispatch recovery",
  ],
  [
    /^(server\/release-[^/]+|routes\/release|release-(store|candidate-store|tarball-cache))\.ts$/,
    "fs process",
    "Dispatch releases",
  ],
  [/^server\/runner-(artifacts|dev-key)\.ts$/, "fs", "runner installer assets"],
  [/^(startup\/|main\.ts$)/, "fs process", "Dispatch bootstrap"],
  [
    /^(local-tls|routes\/local-trust)\.ts$/,
    "fs openssl",
    "Dispatch certificates",
  ],
  [
    /^(config|state-dir|multi-listener|diagnostics|server\/http-logging|server)\.ts$/,
    "fs os",
    "Dispatch config, sockets and logs",
  ],
  [
    /^(files\/(store|send-file|image-variants)|routes\/(files|browser-extension)|agents\/(file-seed|retention)|tasks\/attachment-store)\.ts$/,
    "fs",
    "Dispatch blob storage",
  ],
  [
    /^observability\/artifact-storage\.ts$/,
    "fs du",
    "Dispatch storage metering",
  ],
  [
    /^(notifications\/slack-link-origins|shared\/lib\/clipboard-capability)\.ts$/,
    "os",
    "controller facts",
  ],
];

// Host modules one own-machine file may import, each with its reason.
const scopedHostImports = new Map([
  [
    "runners/local.ts",
    new Map([
      [
        "shared/process/child-environment",
        "main's environment scrub applies to the local runner child it starts",
      ],
    ]),
  ],
]);

// These exact legacy runner implementations have not moved to packages/runner yet.
const legacyRunner =
  /^agents\/(checkout-worker\.ts$|acp\/(host\/|driver\.ts$|engine-spec\.ts$|host-env\.ts$|host-command\.ts$|opencode-instructions\.ts$|permissions\.ts$|background-[^/]+\.ts$)|remote\/(runner|session-(supervisor|storage|processes|files)|engine-(capability-worker|runner-executor)|github-(runner-executor|pull-request-watches)|update-(agent|trial|probe|verify|stage-cli|fence-store)|workload-(identity|tools))\.ts$)|^terminal\/runner-worker\.ts$/;
const hostModule =
  /^(shared\/(git\/|github\/pr$|process\/|lib\/run-command$|repo-icon$|plugin-status$)|agents\/(workspace(?:-prep)?$|worktree-local-config$|checkout-(?:view|watch|inspection|observation|command-executor)$|default-branch-files$|engine-(?:availability|login|updates)$|provider-plans$|local-runner(?:-[^/]+)?$|acp\/host-client$)|files\/(?:workspace-[^/]+|session-file)$|projects\/resolve-root$|terminal\/(?:pty|process-session)$)/;
const hostBuiltins = new Map([
  ["fs", "fs"],
  ["fs/promises", "fs"],
  ["os", "os"],
  ["child_process", "process"],
  ["worker_threads", "process"],
]);

const placementSymbols = new Set([
  "remotePlacement",
  "agentWorkspaceDir",
  "agentDiffPath",
  "resolveLaunchLocation",
  "defaultPlacement",
]);
const localIds = new Set(["LOCAL_RUNNER_ID", "LOCAL_RUNNER"]);
const bunHostMethods = new Map([
  ["file", "fs"],
  ["write", "fs"],
  ["spawn", "process"],
  ["spawnSync", "process"],
  ["$", "process"],
]);
const comparisons = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
const fixture =
  /(?:^|\/)(?:__tests__|__fixtures__|test|tests)\/|\.(?:test|spec)\.[^.]+$/;

function literal(node) {
  if (node && ts.isStringLiteralLike(node)) return node.text;
}

function member(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node))
    return literal(node.argumentExpression);
}

function reference(node) {
  return ts.isIdentifier(node) ? node.text : member(node);
}

function isTypeOnly(node) {
  if (node.isTypeOnly || node.importClause?.isTypeOnly) return true;
  const bindings = node.importClause?.namedBindings ?? node.exportClause;
  return (
    !node.importClause?.name &&
    bindings?.elements?.length > 0 &&
    bindings.elements.every((item) => item.isTypeOnly)
  );
}

function localTarget(file, specifier) {
  return posix
    .normalize(posix.join(posix.dirname(file), specifier))
    .replace(/\.[cm]?[jt]sx?$/, "");
}

function commandCapability(node, name) {
  const first = node.arguments?.[0];
  const command =
    literal(first) ??
    (first && ts.isArrayLiteralExpression(first)
      ? literal(first.elements[0])
      : undefined);
  return ["openssl", "du"].includes(command) &&
    ["spawn", "spawnSync"].includes(name)
    ? command
    : "process";
}

function runnerId(node) {
  const name = reference(node);
  return (
    /^(?:runner|runnerId|runner_id|descriptionId)$/i.test(name ?? "") ||
    (name === "id" &&
      /runner|description/i.test(node.expression?.getText() ?? ""))
  );
}

function isLoopback(value) {
  return /(?:^|\/\/)(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?=[:/\s`]|$)/i.test(
    value ?? ""
  );
}

const leaks = [
  ["packages/runner-protocol/src/execution.ts", "personaContext", "T24"],
  [server + "agents/acp/host-protocol.ts", "PromptSource", "T24"],
  [server + "agents/remote/session-supervisor.ts", "DISPATCH_", "T24"],
  [server + "agents/remote/session-storage.ts", "dispatchReviewBase", "T20"],
  [server + "agents/checkout-inspection.ts", "owner-review-files.js", "T09"],
  ["packages/runner-protocol/src/checkout-view.ts", "excludingTests", "T09"],
  [
    "packages/runner-protocol/src/checkout-command.ts",
    "checkoutCommandTimeoutMs",
    "T14",
  ],
  [
    server + "agents/remote/engine-capability-worker.ts",
    "dispatch@dispatch",
    "T31",
  ],
  [server + "agents/remote/session-supervisor.ts", "agt_", "T25"],
  [server + "agents/acp/host-command.ts", "DISPATCH_", "T24"],
  [server + "agents/remote/runner.ts", 'case "repo":', "T09"],
  [
    server + "agents/remote/github-pull-request-watches.ts",
    "setTimeout",
    "T33",
  ],
];

export function scanSource(file, source, declared = new Set()) {
  const hits = [];
  const hit = (kind, detail, task) => hits.push({ file, kind, detail, task });
  if (fixture.test(file)) return hits;
  if (file.endsWith(".sql")) {
    const locators = [...source.matchAll(/runner:\/\//gi)];
    // This migration copies placement out of historical locators once.
    const historicalBackfill =
      file === server + "db/migrations/0064_agent_runner_id.sql" ||
      file === server + "db/migrations/0065_saved_launch_locations.sql";
    for (const _ of locators.slice(historicalBackfill ? 1 : 0))
      hit("R1 locator", "runner:// in SQL");
    return hits;
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const relative = file.slice(server.length);
  const inServer = file.startsWith(server);
  const inWeb = file.startsWith(web);
  const inRunners = inServer && relative.startsWith("runners/");
  const inLegacyRunner = inServer && legacyRunner.test(relative);
  const packageName = file.match(/^packages\/(runner[^/]*)\/src\//)?.[1];
  const controller = inServer && !inLegacyRunner;
  const placementKind = inWeb ? "R6" : "R1";
  const checkPlacement = (controller && !inRunners) || inWeb;
  const allowed = new Set(
    ownMachine.find(([path]) => path.test(relative))?.[1].split(" ")
  );
  const aliases = new Map();
  const moduleCalls = new Set(["require"]);

  function hostUse(capability, detail) {
    if (controller && !allowed.has(capability)) hit("R2 host access", detail);
  }

  function importEdge(specifier, typeOnly, node, form) {
    if (specifier === undefined) {
      if (controller || packageName || inWeb) hit("R2 computed import", form);
      return;
    }
    const isRelative = specifier.startsWith(".");
    const target = isRelative ? localTarget(file, specifier) : specifier;
    if (packageName) {
      const packageRoot = `packages/${packageName}/src`;
      const name = specifier
        .split("/")
        .slice(0, specifier.startsWith("@") ? 2 : 1)
        .join("/");
      const builtin = tsNodeBuiltins.has(specifier.replace(/^node:/, ""));
      const forbidden =
        name === "pg" ||
        name === "fastify" ||
        name === "@dispatch/server" ||
        name === "@dispatch/shared" ||
        (packageName === "runner-protocol" &&
          !isRelative &&
          name !== "@dispatch/runner-protocol") ||
        ((packageName === "runner-client" ||
          packageName === "runner-conformance") &&
          name === "@dispatch/runner") ||
        (packageName === "runner-client" &&
          /^(?:node:)?child_process$/.test(specifier) &&
          !file.startsWith(packageRoot + "/launcher/"));
      if (
        forbidden ||
        (isRelative
          ? !target.startsWith(packageRoot + "/")
          : !builtin &&
            !declared.has(name) &&
            name !== `@dispatch/${packageName}`)
      )
        hit("R5 package import", specifier);
    }
    if (
      inLegacyRunner &&
      (target.startsWith(server) ||
        /^(@dispatch\/(?:server|shared)|pg|fastify)(\/|$)/.test(target))
    ) {
      if (
        !target.startsWith(server) ||
        (!legacyRunner.test(target.slice(server.length) + ".ts") &&
          !hostModule.test(target.slice(server.length)) &&
          target !== server + "runners/enrolled/v1-framing")
      )
        hit("R5 runner to Dispatch", target);
    }
    if (inServer || inWeb) {
      const builtin = hostBuiltins.get(specifier.replace(/^node:/, ""));
      if (builtin && !typeOnly)
        hostUse(builtin, specifier.replace(/^node:/, ""));
      // T09's in-process fallback: the local adapter runs the checkout
      // workload itself for sessions the child holds no current binding for.
      const inProcessReads =
        relative === "runners/local.ts" &&
        target === server + "agents/checkout-worker";
      if (inProcessReads)
        hit(
          "R3 local adapter delegation",
          "checkout reads in process without a current child binding",
          "T18"
        );
      if (
        !inProcessReads &&
        target.startsWith(server) &&
        (hostModule.test(target.slice(server.length)) ||
          legacyRunner.test(target.slice(server.length) + ".ts"))
      ) {
        if (
          controller &&
          !scopedHostImports.get(relative)?.has(target.slice(server.length))
        )
          hit("R2 host import", target);
      }
      if (/^@dispatch\/runner(?:\/|$)/.test(specifier)) {
        // The CLI exception is confined to dynamic imports inside a subcommand branch.
        const inSubcommand =
          file === server + "main.ts" &&
          specifier === "@dispatch/runner/cli" &&
          form === "import()" &&
          ts.findAncestor(node, (parent) => {
            if (
              !ts.isIfStatement(parent) ||
              node.pos < parent.thenStatement.pos ||
              node.end > parent.thenStatement.end
            )
              return false;
            const condition = parent.expression;
            return (
              ts.isBinaryExpression(condition) &&
              condition.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken &&
              ["command", "process.argv[2]"].includes(
                condition.left.getText()
              ) &&
              ["agent-host", "local-runner", "remote-runner"].includes(
                literal(condition.right)
              )
            );
          });
        if (!inSubcommand) hit("R5 Dispatch to runner", specifier);
      }
      if (
        /^@dispatch\/runner-client(?:\/|$)/.test(specifier) &&
        !(
          file === server + "runners/local.ts" ||
          file.startsWith(server + "runners/enrolled/")
        )
      ) {
        hit("R5 Dispatch to client transport", specifier);
      }
      if (
        inWeb &&
        /^@dispatch\/runner-protocol(?:\/|$)/.test(specifier) &&
        !typeOnly
      )
        hit("R6 protocol value import", specifier);
      // The design names the four operations. Call sites are assigned when T04
      // introduces this module, so T02 starts with an empty caller allowlist.
      if (target === machine) hit("R1 controller-machine import", target);
    }
  }

  // Resolve simple import aliases without creating a project-wide type checker.
  for (const node of tree.statements) {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const item of node.importClause.namedBindings.elements)
        aliases.set(item.name.text, (item.propertyName ?? item.name).text);
    }
  }

  const printer = ts.createPrinter({ removeComments: true });
  const expression = (node) =>
    printer.printNode(ts.EmitHint.Unspecified, node, tree).replace(/\s+/g, " ");

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier)
        importEdge(
          literal(node.moduleSpecifier),
          isTypeOnly(node),
          node,
          "import/export"
        );
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      importEdge(
        literal(node.moduleReference.expression),
        node.isTypeOnly,
        node,
        "import = require"
      );
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      importEdge(literal(node.argument.literal), true, node, "import type");

    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node)
    ) {
      const callable = ts.isTaggedTemplateExpression(node)
        ? node.tag
        : node.expression;
      const args = node.arguments ?? [];
      const name = reference(callable);
      const symbol = aliases.get(name) ?? name;
      const receiver = member(callable) && callable.expression.getText();
      if (
        callable.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callable) && moduleCalls.has(name)) ||
        (ts.isCallExpression(callable) &&
          (aliases.get(reference(callable.expression)) ??
            reference(callable.expression)) === "createRequire") ||
        (name === "require" && ["module", "globalThis"].includes(receiver))
      ) {
        importEdge(
          literal(args[0]),
          false,
          node,
          callable.kind === ts.SyntaxKind.ImportKeyword ? "import()" : "require"
        );
      }
      if (symbol === "createRequire") {
        hostUse("module-loader", "createRequire");
        if (
          ts.isVariableDeclaration(node.parent) &&
          ts.isIdentifier(node.parent.name)
        )
          moduleCalls.add(node.parent.name.text);
      }
      if (
        ["fetch", "WebSocket"].includes(name) &&
        (isLoopback(literal(args[0])) ||
          (args[0] &&
            ts.isTemplateExpression(args[0]) &&
            isLoopback(args[0].head.text)))
      )
        hostUse("loopback", `loopback ${name}`);
      if (checkPlacement && placementSymbols.has(symbol))
        hit(`${placementKind} placement call`, expression(node));
    }
    const name = member(node);
    const receiver = name && node.expression.getText();
    if (receiver === "Bun" || receiver === "globalThis.Bun") {
      const cap = bunHostMethods.get(name);
      const call =
        ts.isCallExpression(node.parent) && node.parent.expression === node
          ? node.parent
          : {};
      if (cap)
        hostUse(
          cap === "process" ? commandCapability(call, name) : cap,
          `Bun.${name}`
        );
    }
    if (
      (receiver === "process" || receiver === "globalThis.process") &&
      (name === "kill" || name === "getBuiltinModule")
    )
      hostUse(name === "kill" ? "process" : "module-loader", `process.${name}`);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const receiver = node.initializer.getText();
      for (const element of node.name.elements) {
        const name = reference(element.propertyName ?? element.name);
        if (receiver === "Bun" || receiver === "globalThis.Bun") {
          const cap = bunHostMethods.get(name);
          if (cap) hostUse(cap, `Bun.${name}`);
        }
        if (
          (receiver === "process" || receiver === "globalThis.process") &&
          (name === "kill" || name === "getBuiltinModule")
        )
          hostUse(
            name === "kill" ? "process" : "module-loader",
            `process.${name}`
          );
      }
    }
    if (checkPlacement) {
      if (name === "runner" && !/^(?:this|this\.options)$/.test(receiver))
        hit(`${placementKind} placement read`, expression(node));
      if (name === "remote" && /^(?:entry|current|session)$/.test(receiver))
        hit(`${placementKind} placement read`, expression(node));
      if (inWeb && name === "runnerManaged")
        hit("R6 placement read", expression(node));
      if (
        ts.isBindingElement(node) &&
        reference(node.propertyName ?? node.name) === "runner"
      )
        hit(`${placementKind} placement read`, `{ ${expression(node)} }`);
      if (ts.isIdentifier(node) && localIds.has(node.text))
        hit(`${placementKind} local ID`, node.text);
    }
    if (
      (checkPlacement || inLegacyRunner) &&
      (
        literal(node) ??
        (ts.isTemplateHead(node) || ts.isRegularExpressionLiteral(node)
          ? node.getText()
          : "")
      )
        .replaceAll("\\/", "/")
        .includes("runner://")
    )
      hit(`${placementKind} locator`, "runner://");
    if (
      (inServer || inWeb) &&
      ts.isBinaryExpression(node) &&
      comparisons.has(node.operatorToken.kind)
    ) {
      if (
        (runnerId(node.left) && literal(node.right) !== undefined) ||
        (runnerId(node.right) && literal(node.left) !== undefined)
      )
        hit(
          `${placementKind} runner ID comparison`,
          "runner ID compared to a literal"
        );
    }
    if (
      file === machine + ".ts" &&
      ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const names = ts.isVariableStatement(node)
        ? node.declarationList.declarations.map((declaration) =>
            declaration.name.getText()
          )
        : [node.name?.getText() ?? "default"];
      for (const name of names)
        if (!machineExports.has(name))
          hit("R1 controller-machine export", name);
    }
    if (file === machine + ".ts" && ts.isExportDeclaration(node)) {
      const names =
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((item) => item.name.text)
          : ["*"];
      for (const name of names)
        if (!machineExports.has(name))
          hit("R1 controller-machine export", name);
    }
    if (file === machine + ".ts" && ts.isExportAssignment(node))
      hit("R1 controller-machine export", "default");

    if (
      /^createLocal(?:Engine)?Runner$/.test(node.name?.getText() ?? "") &&
      /^agents\/local-runner(?:-engine)?\.ts$/.test(relative) &&
      ts.isFunctionDeclaration(node)
    ) {
      const result = node.body?.statements.findLast(
        ts.isReturnStatement
      )?.expression;
      if (result && ts.isObjectLiteralExpression(result)) {
        const shared = relative.endsWith("-engine.ts")
          ? "handle"
          : "requestSession";
        for (const property of result.properties) {
          const method = property.name?.getText() ?? "...spread";
          if (method !== shared) hit("R3 local method", method);
        }
      }
    }
    if (
      relative === "agents/local-runner.ts" &&
      ts.isTypeAliasDeclaration(node) &&
      ["LocalLaunchSettings", "NativeHostProcess"].includes(node.name.text)
    )
      hit("R3 local side channel", node.name.text);
    if (
      relative === "runners/local.ts" &&
      ts.isCallExpression(node) &&
      node.expression.getText() === "local.requestSession"
    )
      hit(
        "R3 local adapter delegation",
        "checkout.exec and manifest read",
        "L3"
      );
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const [path, anchor, task] of leaks)
    if (path === file && source.includes(anchor))
      hit("R5 protocol leak", anchor, task);
  return hits;
}

const key = ({ file, kind, detail }) => JSON.stringify([file, kind, detail]);

export function countHits(hits) {
  const entries = new Map();
  for (const hit of hits) {
    const id = key(hit);
    const previous = entries.get(id);
    if (previous) previous.count++;
    else
      entries.set(id, {
        ...hit,
        count: 1,
        task:
          hit.task ??
          {
            R1: "T07",
            R2: "T04",
            R3: "T04",
            R5: "T04",
            R6: "T38",
          }[hit.kind.slice(0, 2)],
      });
  }
  return [...entries.values()].sort((a, b) =>
    key(a).localeCompare(key(b), "en")
  );
}

function indexEntries(entries) {
  const index = new Map();
  for (const entry of entries) {
    if (
      !entry.file ||
      !entry.kind ||
      !entry.detail ||
      !entry.task ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 1 ||
      index.has(key(entry))
    )
      throw new Error(`Invalid baseline entry: ${JSON.stringify(entry)}`);
    index.set(key(entry), entry);
  }
  return index;
}

function diagnostic(entry) {
  return `${entry.file}: ${entry.kind}: ${entry.detail}`;
}

export function compareHits(hits, baseline) {
  const current = indexEntries(hits);
  const previous = indexEntries(baseline);
  const errors = [];
  for (const [id, entry] of current) {
    const count = previous.get(id)?.count ?? 0;
    if (entry.count > count)
      errors.push(`New hit (${count} → ${entry.count}): ${diagnostic(entry)}`);
  }
  for (const [id, entry] of previous) {
    const count = current.get(id)?.count ?? 0;
    if (entry.count > count)
      errors.push(
        `Stale baseline (${entry.count} → ${count}): ${diagnostic(entry)}`
      );
  }
  return errors;
}

export function compareHistory(previous, next) {
  if (!previous) return []; // Initial adoption on a branch without a baseline.
  if (!next)
    return [
      "The baseline was deleted. Keep an empty list when all entries are removed.",
    ];
  const before = indexEntries(previous);
  const after = indexEntries(next);
  const errors = [];
  const archiveDialog = "apps/web/src/components/app/delete-agent-dialog.tsx";
  const retiredDialogHitIds = [
    key({ file: archiveDialog, kind: "R6 locator", detail: "runner://" }),
    key({
      file: archiveDialog,
      kind: "R6 placement read",
      detail: "deleteTarget?.runnerManaged",
    }),
  ];
  const restoresArchiveDialog = retiredDialogHitIds.every(
    (id) => before.has(id) && !after.has(id)
  );
  const legacyCheckoutPlacement = key({
    file: server + "agents/checkout-commands.ts",
    kind: "R1 placement call",
    detail: "remotePlacement(agent.cwd)",
  });
  const checkoutDelegation = key({
    file: server + "runners/local.ts",
    kind: "R3 local adapter delegation",
    detail: "checkout.exec and manifest read",
  });
  const inProcessReads = key({
    file: server + "runners/local.ts",
    kind: "R3 local adapter delegation",
    detail: "checkout reads in process without a current child binding",
  });

  for (const [id, entry] of after) {
    const parent = before.get(id);
    // T05 replaces the checkout placement fork with one temporary delegation.
    if (
      !parent &&
      id === checkoutDelegation &&
      entry.count === 1 &&
      entry.task === "L3" &&
      before.has(legacyCheckoutPlacement) &&
      !after.has(legacyCheckoutPlacement)
    )
      continue;
    // T09 moves checkout reads into the child; the in-process fallback for
    // sessions without a current child binding is one temporary entry,
    // removed by T18 when launches and moves write bindings.
    if (
      !parent &&
      id === inProcessReads &&
      entry.count === 1 &&
      entry.task === "T18" &&
      before.has(checkoutDelegation)
    )
      continue;
    // T09 folds main's four checkout subcommands into one worker entry: its
    // checkout-inspection (2) and checkout-watch (1) imports become at most
    // two of the worker, which holds that same runner code.
    const mainImport = (module) =>
      key({
        file: server + "main.ts",
        kind: "R2 host import",
        detail: server + "agents/" + module,
      });
    if (
      !parent &&
      id === mainImport("checkout-worker") &&
      entry.count <= 2 &&
      entry.task === "T04" &&
      before.has(mainImport("checkout-inspection")) &&
      !after.has(mainImport("checkout-inspection")) &&
      !after.has(mainImport("checkout-watch"))
    )
      continue;
    // P7 records the existing runner release boundary as T20 debt.
    if (
      !parent &&
      restoresArchiveDialog &&
      Object.keys(entry).length ===
        Object.keys(archiveReleaseRestriction).length &&
      Object.entries(archiveReleaseRestriction).every(
        ([key, value]) => entry[key] === value
      )
    )
      continue;
    if (
      !parent ||
      entry.count > parent.count ||
      Object.keys(entry).some(
        (field) => field !== "count" && entry[field] !== parent[field]
      ) ||
      Object.keys(parent).some((field) => !Object.hasOwn(entry, field))
    )
      errors.push(`Baseline may only shrink: ${diagnostic(entry)}`);
  }
  return errors;
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function atRevision(root, revision, path) {
  try {
    return JSON.parse(
      git(root, "show", revision ? `${revision}:${path}` : `:${path}`)
    );
  } catch (error) {
    if (
      error.status === 128 &&
      /does not exist|exists on disk|not in the index/.test(
        error.stderr?.toString()
      )
    )
      return undefined;
    throw error;
  }
}

export function historyErrors(root, base, head) {
  // Full history retains merges that could otherwise hide a grow-then-shrink.
  const commits = git(
    root,
    "rev-list",
    "--full-history",
    `${base}..${head}`,
    "--",
    baselinePath
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const errors = [];
  for (const commit of commits) {
    const parents = git(root, "show", "-s", "--format=%P", commit)
      .trim()
      .split(" ")
      .filter(Boolean);
    const entries = atRevision(root, commit, baselinePath);
    for (const parent of parents) {
      const before = atRevision(root, parent, baselinePath);
      for (const error of compareHistory(before, entries))
        errors.push(`${commit.slice(0, 12)} ${error}`);
    }
  }
  return errors;
}

const sourceRoots = [
  server,
  web,
  ...packages.map((name) => `packages/${name}/src/`),
];
const sourceFile = (file) =>
  sourceRoots.some((prefix) => file.startsWith(prefix)) &&
  /\.(?:[cm]?[jt]sx?|sql)$/.test(file) &&
  !fixture.test(file);

function packageDependencies(read, errors) {
  const manifest = JSON.parse(read("package.json"));
  const dependencies = new Map();
  for (const name of packages) {
    const directory = `packages/${name}`;
    const text = read(`${directory}/package.json`);
    if (!text) {
      if (name === "runner-protocol")
        errors.push("Missing runner-protocol package");
      continue;
    }
    const pkg = JSON.parse(text);
    const config = read(`${directory}/tsconfig.json`);
    if (
      !config ||
      ts.parseConfigFileTextToJson("tsconfig.json", config).config
        ?.compilerOptions?.rootDir !== "src" ||
      !pkg.scripts?.check ||
      !manifest.scripts.check.includes(`--filter ${pkg.name} check`)
    )
      errors.push(
        `${directory} must have its own tsconfig and run its check from the root check.`
      );
    dependencies.set(
      name,
      new Set(
        Object.keys({
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.optionalDependencies,
          ...pkg.peerDependencies,
        })
      )
    );
  }
  return dependencies;
}

function run(args) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  if (args[0] === "--history" && args.length === 3)
    return historyErrors(root, args[1], args[2]);
  if (
    args.length > 1 ||
    (args.length === 1 && !["--staged", "--print"].includes(args[0]))
  )
    throw new Error(
      "Usage: check-runner-boundary.mjs [--staged | --print | --history BASE HEAD]"
    );

  const staged = args[0] === "--staged";
  const indexed = staged
    ? new Set(git(root, "ls-files", "-z").split("\0"))
    : null;
  const unstaged = staged
    ? new Set(git(root, "diff", "--name-only", "-z").split("\0"))
    : null;
  const read = (file) => {
    if (staged && !indexed.has(file)) return;
    if (staged && unstaged.has(file)) return git(root, "show", `:${file}`);
    const path = join(root, file);
    if (existsSync(path)) return readFileSync(path, "utf8");
  };
  const candidates = indexed
    ? [...indexed]
    : git(
        root,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...sourceRoots
      )
        .split("\0")
        .filter((file) => file && existsSync(join(root, file)));
  const files = [...new Set(candidates)].filter(sourceFile);
  for (const prefix of [server, web, "packages/runner-protocol/src/"])
    if (!files.some((file) => file.startsWith(prefix)))
      throw new Error(`No source files scanned under ${prefix}`);

  const errors = [];
  const dependencies = packageDependencies(read, errors);
  const hits = countHits([
    ...files.flatMap((file) =>
      scanSource(file, read(file), dependencies.get(file.split("/")[1]))
    ),
    ...restrictionHits(read),
  ]);
  if (args[0] === "--print") {
    console.log(JSON.stringify(hits, null, 2));
    return errors;
  }
  const baseline = JSON.parse(read(baselinePath));
  errors.push(...compareHits(hits, baseline));
  if (staged)
    errors.push(
      ...compareHistory(atRevision(root, "HEAD", baselinePath), baseline)
    );
  if (!errors.length) {
    const counts = {};
    for (const entry of hits) {
      const rule = entry.kind.slice(0, 2);
      counts[rule] = (counts[rule] ?? 0) + entry.count;
    }
    console.log(
      `Runner boundary checked ${files.length} files (${Object.entries(counts)
        .sort()
        .map(([rule, count]) => `${rule}: ${count}`)
        .join(", ")}).`
    );
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const errors = run(process.argv.slice(2));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
