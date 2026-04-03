import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { AuthContextProvider } from "@/contexts/auth-context";
import { AuthLayout } from "@/layouts/auth-layout";
import { DashboardLayout } from "@/App";
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
              { index: true },
              { path: "settings" },
              { path: "settings/:section" },
              { path: "docs" },
              { path: "docs/:section" },
              { path: "activity" },
              { path: "activity/:tab" },
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
