import type { PoolClient } from "pg";
import { SURFACE_SCHEMA_VERSION } from "@dispatch/shared";

const owner = "seed-agent-running-feature";

// These documents are intentionally narrow-pane examples rather than a page
// builder. Together they exercise every v2 leaf, slot, and form control in
// realistic agent-to-user decision flows: header (status + progress), footer
// actions, section actions, per-item action menus, toned text callouts, and
// key/value tables.
export const surfaceExamples = [
  {
    id: "tab_seed_release_choice",
    title: "Release decision",
    icon: "flag",
    sortOrder: 0,
    header: {
      status: {
        id: "context",
        type: "status",
        title: "Deployment status",
        status: "Ready for decision",
        tone: "info",
        detail: "Both paths passed CI. **Canary** reduces blast radius.",
        timestamp: "2026-08-27T15:30:00.000Z",
      },
    },
    blocks: [
      {
        id: "comparison",
        type: "table",
        title: "Release paths",
        description: "Choose the rollout shape for `v4.18.0`.",
        columns: [
          { id: "option", label: "Option", priority: "primary" },
          { id: "time", label: "Time", priority: "primary" },
          {
            id: "risk",
            label: "Risk",
            format: "badge",
            badgeVariants: { Lower: "success", Higher: "warning" },
            priority: "primary",
          },
        ],
        rows: [
          {
            id: "canary",
            cells: { option: "Canary", time: "~30 min", risk: "Lower" },
          },
          {
            id: "direct",
            cells: { option: "Direct", time: "~8 min", risk: "Higher" },
          },
        ],
      },
    ],
    footer: {
      actions: [
        {
          id: "canary",
          label: "Use canary",
          intent: "choose_release_canary",
          style: "primary",
          icon: "flag",
        },
        {
          id: "direct",
          label: "Release directly",
          intent: "choose_release_direct",
          style: "destructive",
          confirm: {
            title: "Release directly?",
            description: "This skips the observation window.",
          },
        },
      ],
    },
  },
  {
    id: "tab_seed_feedback",
    title: "Design feedback",
    icon: "form",
    sortOrder: 1,
    header: {
      status: {
        id: "status",
        type: "status",
        status: "Ready for review",
        tone: "success",
        detail: "Focus on hierarchy, density, and the interaction flow.",
      },
    },
    blocks: [
      {
        id: "feedback",
        type: "form",
        title: "Share your review",
        description: "Your draft remains in this tab until you send it.",
        fields: [
          {
            id: "decision",
            type: "radio",
            label: "Overall direction",
            description: "Select the clearest next step.",
            required: true,
            options: [
              {
                value: "approve",
                label: "Keep this direction",
                description: "Proceed with the current approach.",
              },
              {
                value: "revise",
                label: "Revise it",
                description: "Keep the concept, adjust the details.",
              },
              { value: "restart", label: "Try another direction" },
            ],
          },
          {
            id: "notes",
            type: "textarea",
            label: "Specific notes",
            required: true,
            placeholder: "What should change, and why?",
            minLength: 5,
            maxLength: 2000,
          },
        ],
        submit: {
          id: "submit",
          label: "Send feedback",
          intent: "submit_design_feedback",
          icon: "message",
        },
        resetLabel: "Clear draft",
        submitMode: "repeatable",
      },
    ],
  },
  {
    id: "tab_seed_work_summary",
    title: "Release work summary",
    icon: "checklist",
    sortOrder: 2,
    header: {
      progress: {
        id: "readiness",
        type: "progress",
        title: "Release readiness",
        value: 5,
        max: 8,
        label: "5 of 8 complete",
        detail: "Two items need a decision; one is waiting on CI.",
      },
    },
    blocks: [
      {
        id: "release_details",
        type: "section",
        title: "Release details",
        description: "Work items and the controls used to unblock them.",
        collapse: { initiallyCollapsed: true },
        blocks: [
          {
            id: "work",
            type: "list",
            title: "Work items",
            style: "check",
            items: [
              {
                id: "schema",
                text: "Finalize interaction schema",
                status: "Complete",
                tone: "success",
                checked: true,
                detail: "Validated against the client contract.",
                group: "Completed",
              },
              {
                id: "migration",
                text: "Apply production migration",
                status: "Needs approval",
                tone: "warning",
                detail: "Queue it once the release owner approves.",
                url: "https://example.com/runbooks/migration",
                group: "Next steps",
                actions: [
                  {
                    id: "queue_migration",
                    label: "Queue",
                    intent: "queue_release_migration",
                  },
                  {
                    id: "hold_migration",
                    label: "Hold",
                    intent: "hold_release_migration",
                  },
                ],
              },
              {
                id: "a11y",
                text: "Accessibility review",
                status: "Waiting on prototype",
                tone: "danger",
                detail: "Waiting for the latest prototype.",
                group: "Next steps",
              },
              {
                id: "notes",
                text: "Publish release notes",
                status: "Not started",
                tone: "neutral",
                group: "Next steps",
              },
            ],
            collapse: { after: 2, label: "Show all release work" },
            showItemCount: true,
          },
        ],
        actions: [
          {
            id: "queue_all",
            label: "Queue migration",
            intent: "queue_release_migration",
            style: "primary",
            icon: "clock",
          },
          {
            id: "hold",
            label: "Keep on hold",
            intent: "hold_release_work",
          },
        ],
      },
    ],
  },
  {
    id: "tab_seed_incident",
    title: "Incident handoff",
    icon: "message",
    sortOrder: 3,
    header: {
      status: {
        id: "severity",
        type: "status",
        status: "Monitoring",
        tone: "warning",
        detail:
          "No new errors for 12 minutes; continue watching the primary region.",
        timestamp: "2026-08-27T15:42:00.000Z",
      },
    },
    blocks: [
      {
        id: "summary",
        type: "text",
        title: "What changed",
        text: "The checkout error rate is back within baseline after rolling back the **pricing worker**. [Open the runbook](https://example.com/runbook) before taking the handoff.",
      },
      {
        id: "risk_note",
        type: "text",
        title: "Watch out",
        tone: "warning",
        text: "The pricing worker rollback leaves surge pricing disabled — re-enable it before the 18:00 UTC peak.",
      },
      {
        id: "timeline",
        type: "list",
        title: "Timeline",
        style: "number",
        items: [
          {
            id: "detect",
            text: "Alert fired at 15:08 UTC",
            status: "Complete",
            tone: "success",
          },
          {
            id: "rollback",
            text: "Rolled back pricing worker",
            status: "Complete",
            tone: "success",
          },
          {
            id: "observe",
            text: "Observe regional error rate",
            status: "Monitoring",
            tone: "info",
          },
        ],
      },
      {
        id: "impact",
        type: "table",
        title: "Impact",
        columns: [
          { id: "metric", label: "Metric" },
          { id: "value", label: "Value" },
        ],
        rows: [
          {
            id: "duration",
            cells: { metric: "Duration", value: "34 minutes" },
          },
          { id: "failed", cells: { metric: "Failed checkouts", value: 1204 } },
          {
            id: "regions",
            cells: { metric: "Regions affected", value: "us-east-1" },
          },
        ],
      },
    ],
    footer: {
      actions: [
        {
          id: "ack",
          label: "Acknowledge handoff",
          intent: "acknowledge_incident_handoff",
          style: "primary",
          icon: "checklist",
        },
        {
          id: "page",
          label: "Page incident lead",
          intent: "page_incident_lead",
          style: "destructive",
          icon: "flag",
          confirm: { title: "Page the incident lead?" },
        },
      ],
    },
  },
  {
    id: "tab_seed_service_health",
    title: "Service health",
    icon: "table",
    sortOrder: 4,
    blocks: [
      {
        id: "health",
        type: "table",
        title: "Production checks",
        showItemCount: true,
        columns: [
          { id: "service", label: "Service", priority: "primary" },
          {
            id: "status",
            label: "Status",
            format: "badge",
            badgeVariants: {
              Healthy: "success",
              Degraded: "warning",
              Outage: "danger",
            },
            priority: "primary",
          },
          {
            id: "latency",
            label: "p95",
            format: "number",
            align: "right",
            priority: "secondary",
          },
          {
            id: "checked",
            label: "Checked",
            format: "date",
            priority: "secondary",
          },
          { id: "trace", label: "Trace", format: "url", priority: "secondary" },
          {
            id: "build",
            label: "Build",
            format: "code",
            priority: "secondary",
          },
        ],
        rows: [
          {
            id: "api",
            cells: {
              service: "API",
              status: "Healthy",
              latency: 142,
              checked: "2026-08-27",
              trace: "https://example.com/traces/api",
              build: "api@4.18.0",
            },
            actions: [
              {
                id: "inspect_api",
                label: "Inspect",
                intent: "inspect_api_health",
              },
            ],
          },
          {
            id: "search",
            cells: {
              service: "Search",
              status: "Degraded",
              latency: 810,
              checked: "2026-08-27",
              trace: "https://example.com/traces/search",
              build: "search@4.18.0",
            },
            actions: [
              {
                id: "retry_search",
                label: "Retry",
                intent: "retry_search_health_check",
              },
              {
                id: "mute_search",
                label: "Mute alerts",
                intent: "mute_search_alerts",
              },
            ],
          },
          {
            id: "worker",
            cells: {
              service: "Worker",
              status: "Outage",
              latency: null,
              checked: "2026-08-27",
              trace: "https://example.com/traces/worker",
              build: "worker@4.17.3",
            },
          },
        ],
      },
      {
        id: "note",
        type: "text",
        text: "Badge values communicate health; secondary columns hold verbose diagnostics that always sit behind row disclosure.",
      },
    ],
  },
  {
    id: "tab_seed_intake",
    title: "Research intake",
    icon: "form",
    sortOrder: 5,
    blocks: [
      {
        id: "intro",
        type: "text",
        title: "Request a focused pass",
        text: "Give the agent a scoped question, target environment, and the maximum time to spend.",
      },
      {
        id: "request",
        type: "form",
        title: "Research request",
        fields: [
          {
            id: "question",
            type: "text",
            label: "Question",
            description: "One answerable question.",
            required: true,
            placeholder: "What should we compare?",
            minLength: 8,
            maxLength: 140,
          },
          {
            id: "scope",
            type: "select",
            label: "Scope",
            required: true,
            defaultValue: "repo",
            options: [
              {
                value: "repo",
                label: "This repository",
                description: "Code, docs, and tests in the current worktree.",
              },
              {
                value: "web",
                label: "Public web",
                description: "Current external documentation.",
              },
              { value: "both", label: "Repository and web" },
            ],
          },
          {
            id: "areas",
            type: "select",
            label: "Areas to inspect",
            multiple: true,
            defaultValue: ["code", "tests"],
            options: [
              { value: "code", label: "Code" },
              { value: "tests", label: "Tests" },
              { value: "docs", label: "Documentation" },
              {
                value: "history",
                label: "Git history",
                disabled: true,
                description: "Unavailable in this example.",
              },
            ],
          },
          {
            id: "budget",
            type: "number",
            label: "Time budget (minutes)",
            description: "Use a small budget for the first pass.",
            required: true,
            min: 5,
            max: 120,
            step: 5,
            defaultValue: 20,
          },
          {
            id: "notify",
            type: "checkbox",
            label: "Notify me when complete",
            description: "Sends a durable result notification.",
            defaultValue: true,
          },
        ],
        submit: {
          id: "start",
          label: "Start research",
          intent: "submit_research_request",
          icon: "sparkles",
        },
        resetLabel: "Reset request",
        submitMode: "once",
      },
    ],
  },
  {
    id: "tab_seed_change_log",
    title: "Change log",
    icon: "list",
    sortOrder: 6,
    blocks: [
      {
        id: "updates",
        type: "list",
        title: "Today’s updates",
        style: "bullet",
        items: [
          {
            id: "seed",
            text: "Expanded **surface examples** for sidebar coverage.",
            detail: "Includes slots, forms, and compact data leaves.",
          },
          {
            id: "badge",
            text: "Added semantic variants for badge-formatted table cells.",
          },
          {
            id: "notice",
            text: "Wrapped durable interaction notices in Dispatch boundaries.",
          },
        ],
      },
      {
        id: "complete",
        type: "status",
        status: "No action needed",
        tone: "neutral",
        detail: "This is a read-only status update.",
      },
    ],
  },
  {
    id: "tab_seed_access_request",
    title: "Access request",
    icon: "clock",
    sortOrder: 7,
    header: {
      status: {
        id: "review_state",
        type: "status",
        status: "Awaiting approval",
        tone: "danger",
        detail: "The requested production role is not yet assigned.",
      },
    },
    blocks: [
      {
        id: "grant_terms",
        type: "text",
        title: "Grant terms",
        tone: "info",
        text: "Approval issues a temporary production role that expires automatically after one hour.",
      },
    ],
    footer: {
      actions: [
        {
          id: "approve",
          label: "Approve temporary access",
          intent: "approve_temporary_access",
          style: "primary",
          confirm: {
            title: "Approve temporary access?",
            description: "Access expires automatically after one hour.",
          },
        },
        {
          id: "revoke",
          label: "Revoke access",
          intent: "revoke_access",
          style: "destructive",
          disabled: true,
          disabledReason: "No active access grant exists.",
        },
      ],
    },
  },
] as const;

export async function seedSurfaces(client: PoolClient): Promise<void> {
  for (const surface of surfaceExamples) {
    const withSlots = surface as {
      header?: unknown;
      footer?: unknown;
    };
    await client.query(
      `INSERT INTO agent_surfaces (id, agent_id, title, icon, sort_order, schema_version, header, blocks, footer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        surface.id,
        owner,
        surface.title,
        surface.icon,
        surface.sortOrder,
        SURFACE_SCHEMA_VERSION,
        withSlots.header ? JSON.stringify(withSlots.header) : null,
        JSON.stringify(surface.blocks),
        withSlots.footer ? JSON.stringify(withSlots.footer) : null,
      ]
    );
  }
}
