import { createBrowserRouter, Navigate } from "react-router-dom";
import { AuthLayout } from "@/layouts/auth-layout";
import { DashboardLayout } from "@/App";
import { AgentsRoute } from "@/layouts/agents-route";
import { RouteLoadError, RouteLoading } from "@/layouts/route-loading";
import { LoginRoute } from "@/components/app/login-page";
import {
  LegacyDocsRedirect,
  LegacyJobsRedirect,
  RootLayout,
} from "@/router-layouts";

const loadSettingsRoute = async () => {
  const { SettingsRoute } = await import("@/layouts/settings-route");
  return { Component: SettingsRoute };
};

const loadActivityRoute = async () => {
  const { ActivityRoute } = await import("@/layouts/activity-route");
  return { Component: ActivityRoute };
};

const loadAutomationsRoute = async () => {
  const { AutomationsRoute } = await import("@/layouts/automations-route");
  return { Component: AutomationsRoute };
};

const loadDesignLabRoute = async () => {
  const { DesignLabRoute } = await import("@/layouts/design-lab-route");
  return { Component: DesignLabRoute };
};

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    HydrateFallback: RouteLoading,
    ErrorBoundary: RouteLoadError,
    children: [
      {
        path: "/login",
        element: <LoginRoute />,
      },
      {
        element: <AuthLayout />,
        children: [
          {
            element: <DashboardLayout />,
            children: [
              { index: true, element: <Navigate to="/agents" replace /> },
              {
                path: "agents",
                element: <AgentsRoute />,
                handle: { navSection: "agents" },
              },
              {
                path: "agents/:agentId/*",
                element: <AgentsRoute />,
                handle: { navSection: "agents" },
              },
              {
                path: "settings",
                lazy: loadSettingsRoute,
                handle: { navSection: "settings" },
              },
              {
                path: "settings/:section",
                lazy: loadSettingsRoute,
                handle: { navSection: "settings" },
              },
              {
                path: "settings/:section/:subsection",
                lazy: loadSettingsRoute,
                handle: { navSection: "settings" },
              },
              {
                path: "docs",
                element: <Navigate to="/settings/help" replace />,
              },
              {
                path: "docs/:section",
                element: <LegacyDocsRedirect />,
              },
              {
                path: "activity",
                element: <Navigate to="/activity/metrics" replace />,
                handle: { navSection: "activity" },
              },
              {
                path: "activity/:tab",
                lazy: loadActivityRoute,
                handle: { navSection: "activity" },
              },
              {
                path: "activity/:tab/:agentId",
                lazy: loadActivityRoute,
                handle: { navSection: "activity" },
              },
              {
                path: "automations",
                lazy: loadAutomationsRoute,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/templates/:templateId",
                lazy: loadAutomationsRoute,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/jobs",
                lazy: loadAutomationsRoute,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/jobs/:jobId",
                lazy: loadAutomationsRoute,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/jobs/:jobId/:section",
                lazy: loadAutomationsRoute,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/jobs/:jobId/:section/:runId",
                lazy: loadAutomationsRoute,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/brains",
                lazy: loadAutomationsRoute,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/brains/:encodedRepoRoot",
                lazy: loadAutomationsRoute,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/brains/:encodedRepoRoot/:collection",
                lazy: loadAutomationsRoute,
                handle: { navSection: "automations" },
              },
              {
                path: "jobs",
                element: <Navigate to="/automations/jobs" replace />,
              },
              {
                path: "jobs/*",
                element: <LegacyJobsRedirect />,
              },
              {
                path: "design-lab",
                lazy: loadDesignLabRoute,
              },
            ],
          },
        ],
      },
      {
        path: "*",
        element: <Navigate to="/" replace />,
      },
    ],
  },
]);
