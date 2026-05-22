import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useParams,
} from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { AuthContextProvider } from "@/contexts/auth-context";
import { AuthLayout } from "@/layouts/auth-layout";
import { DashboardLayout } from "@/App";
import {
  ActivityRoute,
  AgentsRoute,
  AutomationsRoute,
  DesignLabRoute,
  SettingsRoute,
} from "@/layouts/dashboard-sections";
import { LoginRoute } from "@/components/app/login-page";

function RootLayout(): JSX.Element {
  const auth = useAuth();
  return (
    <AuthContextProvider value={auth}>
      <Outlet />
    </AuthContextProvider>
  );
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
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
                path: "agents/:agentId",
                element: <AgentsRoute />,
                handle: { navSection: "agents" },
              },
              {
                path: "agents/:agentId/feedback/:itemId",
                element: <AgentsRoute />,
                handle: { navSection: "agents" },
              },
              {
                path: "agents/:agentId/review/:summaryAgentId",
                element: <AgentsRoute />,
                handle: { navSection: "agents" },
              },
              {
                path: "settings",
                element: <SettingsRoute />,
                handle: { navSection: "settings" },
              },
              {
                path: "settings/:section",
                element: <SettingsRoute />,
                handle: { navSection: "settings" },
              },
              {
                path: "settings/:section/:subsection",
                element: <SettingsRoute />,
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
                element: <ActivityRoute />,
                handle: { navSection: "activity" },
              },
              {
                path: "automations",
                element: <AutomationsRoute />,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/templates/:templateId",
                element: <AutomationsRoute />,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/jobs",
                element: <AutomationsRoute />,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/jobs/:jobId",
                element: <AutomationsRoute />,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/jobs/:jobId/:section",
                element: <AutomationsRoute />,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/jobs/:jobId/:section/:runId",
                element: <AutomationsRoute />,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/brains",
                element: <AutomationsRoute />,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/brains/:encodedRepoRoot",
                element: <AutomationsRoute />,
                handle: { navSection: "automations" },
              },
              {
                path: "automations/brains/:encodedRepoRoot/:collection",
                element: <AutomationsRoute />,
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
                element: <DesignLabRoute />,
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

function LegacyDocsRedirect(): JSX.Element {
  const { section } = useParams();
  return (
    <Navigate
      to={section ? `/settings/help/${section}` : "/settings/help"}
      replace
    />
  );
}

function LegacyJobsRedirect(): JSX.Element {
  const { "*": rest } = useParams();
  return <Navigate to={`/automations/jobs/${rest ?? ""}`} replace />;
}
