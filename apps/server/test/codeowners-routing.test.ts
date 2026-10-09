import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadCodeowners,
  resolveCodeowners,
} from "../src/personas/codeowners.js";

const root = path.resolve(import.meta.dirname, "../../..");

// Real files anchor cross-layer routing. Exact sets also catch accidental fan-out.
const cases: [string, string[]][] = [
  [
    "apps/macos/Sources/DispatchCore/UpdateRecovery.swift",
    ["release-update-owner"],
  ],
  ["apps/server/src/update-recovery/coordinator.ts", ["release-update-owner"]],
  ["apps/server/test/db/migrate.test.ts", ["release-update-owner"]],
  ["packages/shared/src/mac-app-update-types.ts", ["release-update-owner"]],
  [
    "apps/web/src/components/app/updates-section.tsx",
    ["release-update-owner", "frontend-react-review"],
  ],
  [
    "apps/web/src/components/app/create-agent-dialog.tsx",
    ["agent-runtime-owner", "frontend-react-review"],
  ],
  ["apps/server/test/db/agent-workspace.test.ts", ["agent-runtime-owner"]],
  ["packages/shared/src/permission-types.ts", ["agent-runtime-owner"]],
  [
    "apps/web/src/components/app/personality-settings.tsx",
    ["agent-runtime-owner", "frontend-react-review"],
  ],
  [
    "apps/web/src/components/app/persona-launcher.tsx",
    ["review-lifecycle-owner", "frontend-react-review"],
  ],
  [
    "apps/web/src/components/app/chat/block-bodies.tsx",
    [
      "review-lifecycle-owner",
      "stream-delivery-owner",
      "stream-interactions-owner",
      "frontend-react-review",
    ],
  ],
  [
    "packages/shared/src/block-types.ts",
    ["review-lifecycle-owner", "stream-interactions-owner"],
  ],
  ["apps/server/src/scheduled-messages/service.ts", ["jobs-owner"]],
  [
    "apps/server/src/shared/mcp/scheduled-message-tools.ts",
    ["jobs-owner", "mcp-contract-owner"],
  ],
  ["packages/shared/src/scheduled-messages.ts", ["jobs-owner"]],
  ["e2e/scheduled-messages.spec.ts", ["jobs-owner"]],
  ["apps/server/src/stream-manager.ts", ["stream-delivery-owner"]],
  [
    "apps/web/src/hooks/use-sse.ts",
    ["stream-delivery-owner", "frontend-react-review"],
  ],
  ["packages/shared/src/conversation-delivery.ts", ["stream-delivery-owner"]],
  ["apps/server/src/server/notification-runtime.ts", ["stream-delivery-owner"]],
  ["apps/server/src/auth.ts", ["auth-trust-owner"]],
  ["apps/server/src/browser-origin.ts", ["auth-trust-owner"]],
  [
    "apps/web/src/components/app/login-page.tsx",
    ["auth-trust-owner", "frontend-react-review"],
  ],
  ["apps/server/src/files/workspace-directory.ts", ["workspace-files-owner"]],
  [
    "apps/web/src/components/app/file-lightbox.tsx",
    ["workspace-files-owner", "frontend-react-review"],
  ],
  ["apps/browser-extension/src/service-worker.ts", ["browser-feedback-owner"]],
  [
    "apps/server/src/routes/browser-extension.ts",
    ["browser-feedback-owner", "auth-trust-owner"],
  ],
  [
    "apps/web/src/components/app/browser-extension-settings.tsx",
    ["browser-feedback-owner", "frontend-react-review"],
  ],
  ["apps/web/src/components/ui/button.tsx", ["frontend-react-review"]],
  ["README.md", ["code-review"]],
];

describe("repository ownership coverage", () => {
  it.each(cases)(
    "routes %s to its intended reviewers",
    async (file, expected) => {
      await access(path.join(root, file));
      const config = await loadCodeowners(root);
      const plan = resolveCodeowners(config, [file], "main");
      expect(plan.owners.map((owner) => owner.persona).sort()).toEqual(
        [...expected].sort()
      );
    }
  );

  it("launches the frontend reviewer once across multiple subsystem paths", async () => {
    const config = await loadCodeowners(root);
    const files = cases
      .map(([file]) => file)
      .filter((file) => file.startsWith("apps/web/src/"));
    const plan = resolveCodeowners(config, files, "main");
    const frontend = plan.owners.filter(
      (owner) => owner.persona === "frontend-react-review"
    );
    expect(frontend).toHaveLength(1);
    expect(frontend[0].files).toEqual([...files].sort());
    expect(plan.uncoveredFiles).toEqual([]);
  });
});
