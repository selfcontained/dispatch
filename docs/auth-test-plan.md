# Authentication Test Plan

Covers the password gate, cookie sessions, Bearer token auth, and frontend auth flows.

## Prerequisites

- `dispatch-dev up --live` with a fresh DB (no password set)
- Note the web and API URLs from the output

---

## 1. First-Run Open Access (No Password Set)

### 1a. App loads without auth gate
- Navigate to the web URL
- **Expected:** Main app renders immediately (sidebar, terminal pane, status footer)
- **Expected:** No login screen, no setup screen
- **Expected:** Zero console errors

### 1b. All API routes are open
- `curl <api>/api/v1/agents` (no auth header)
- **Expected:** 200 with `{"agents": [...]}`

### 1c. Health endpoint always open
- `curl <api>/api/v1/health`
- **Expected:** 200 with `{"status": "ok", "db": "ok", ...}`

### 1d. Auth status reports no password
- `curl <api>/api/v1/auth/status`
- **Expected:** `{"passwordSet": false, "authenticated": true}`

### 1e. MCP endpoint is open
- Send MCP initialize request to `<api>/api/mcp` (no auth header)
- **Expected:** Successful MCP response (not 401)

### 1f. Settings → Security shows "Set Password" form
- Open Settings → Security
- **Expected:** Heading says "Set Password"
- **Expected:** Explanatory text about open access
- **Expected:** No "Log out" button visible
- **Expected:** No "Current password" field

---

## 2. Password Setup (via Settings)

### 2a. Validation — password too short
- In Security settings, enter a 3-character password + confirm
- **Expected:** "Set password" button remains disabled

### 2b. Validation — passwords don't match
- Enter "abcd" in password, "abce" in confirm
- **Expected:** "Passwords do not match" error shown

### 2c. Successful setup
- Enter matching password (4+ chars) and click "Set password"
- **Expected:** Success message "Password set successfully."
- **Expected:** Form switches to "Change Password" with current/new/confirm fields
- **Expected:** "Log out" button appears under "Session" heading
- **Expected:** Session cookie `dispatch_session` is set (check DevTools → Cookies)

### 2d. Setup endpoint rejects second call
- `curl -X POST <api>/api/v1/auth/setup -H 'Content-Type: application/json' -d '{"password":"another"}'`
- **Expected:** 400 `{"error": "Password is already set."}`

---

## 3. Auth Hook Enforcement (Password Set)

### 3a. Unauthenticated API calls get 401
- `curl <api>/api/v1/agents` (no auth header, no cookie)
- **Expected:** 401 `{"error": "Authentication required."}`

### 3b. Health endpoint still open
- `curl <api>/api/v1/health`
- **Expected:** 200

### 3c. Auth status still open
- `curl <api>/api/v1/auth/status`
- **Expected:** 200 `{"passwordSet": true, "authenticated": false}`

### 3d. Bearer token grants access
- `curl -H "Authorization: Bearer <AUTH_TOKEN>" <api>/api/v1/agents`
- **Expected:** 200 with agents list

### 3e. Invalid Bearer token rejected
- `curl -H "Authorization: Bearer wrong-token" <api>/api/v1/agents`
- **Expected:** 401

### 3f. MCP with Bearer token works
- Send MCP initialize to `<api>/api/mcp` with `Authorization: Bearer <AUTH_TOKEN>`
- **Expected:** Successful MCP response

### 3g. MCP without auth rejected
- Send MCP initialize to `<api>/api/mcp` (no auth)
- **Expected:** 401

### 3h. SSE /api/v1/events without auth rejected
- `curl <api>/api/v1/events` (no auth)
- **Expected:** 401

### 3i. WebSocket terminal/ws endpoint open (uses its own token auth)
- The `/api/v1/agents/:id/terminal/ws` endpoint should not be blocked by the auth hook
- (It uses short-lived tokens issued by the authenticated `/terminal/token` POST)

---

## 4. Login Flow

### 4a. Logout shows login page
- Click "Log out" in Settings → Security (or navigate after clearing cookies)
- **Expected:** Login page renders with "Dispatch" title, password field, "Sign in" button
- **Expected:** Sign in button disabled when password field empty

### 4b. Wrong password rejected
- Enter wrong password, click "Sign in"
- **Expected:** Error message "Invalid password."
- **Expected:** Stays on login page

### 4c. Correct password succeeds
- Enter correct password, click "Sign in"
- **Expected:** Main app loads with sidebar, terminal pane, status footer
- **Expected:** API/DB status shows "ok"
- **Expected:** SSE connection established (agent updates work)

### 4d. Terminal renders after login
- Create or select an agent after logging in
- **Expected:** Terminal canvas renders with agent CLI output (not blank/black)
- **Expected:** WS status shows "connected"

### 4e. Session persists across page reload
- After login, hard-reload the page (Cmd+R)
- **Expected:** App loads directly (no login screen)
- **Expected:** Auth status returns `authenticated: true`

---

## 5. Change Password

### 5a. Change password form validation
- Open Settings → Security (while logged in with password set)
- **Expected:** Shows "Change Password" heading with current/new/confirm fields

### 5b. Wrong current password rejected
- Enter wrong current password, valid new password + confirm
- **Expected:** Error "Current password is incorrect."

### 5c. New password too short
- Enter correct current password, 3-char new password
- **Expected:** "Change password" button remains disabled

### 5d. Successful change
- Enter correct current password, valid new password (4+ chars) + confirm
- **Expected:** Success message "Password changed successfully."
- **Expected:** Form fields reset

### 5e. Old password no longer works
- Log out, try logging in with old password
- **Expected:** "Invalid password."

### 5f. New password works
- Log in with new password
- **Expected:** App loads successfully

---

## 6. Agent + MCP Integration

### 6a. Create agent with password set
- With password set and logged in, create an agent via the UI
- **Expected:** Agent appears in sidebar
- **Expected:** Terminal connects (WS: connected) and renders CLI output

### 6b. Agent MCP tools work
- The spawned agent's MCP connection to Dispatch should authenticate via Bearer token
- **Expected:** No 401s in server logs for `/api/mcp/<agentId>` requests
- **Expected:** Agent can call `dispatch_event` (status updates appear in UI)
- **Expected:** Agent can call `dispatch_share` (media appears in sidebar)

### 6c. SSE delivers agent updates
- Create an agent via API with Bearer token
- **Expected:** Agent appears in UI sidebar via SSE push (no page reload needed)

---

## 7. Edge Cases

### 7a. Expired session
- Manually delete the session from the `sessions` table
- Reload the page
- **Expected:** Redirected to login page

### 7b. API returns 401 mid-session
- While using the app, manually delete session from DB
- Trigger any API call (e.g., create agent)
- **Expected:** App redirects to login page (authState → "needs-login")

### 7c. Multiple browser tabs
- Log in on tab A, open tab B to same URL
- **Expected:** Tab B loads authenticated (shares same session cookie)
- Log out on tab A, trigger action on tab B
- **Expected:** Tab B redirects to login on next API call

### 7d. Concurrent agents
- With password set, create multiple agents
- **Expected:** All agents' MCP connections authenticate successfully
- **Expected:** All terminals render correctly

---

## 8. Existing Test Suites

### 8a. E2E tests
- `npm run test:e2e`
- **Expected:** All 25 tests pass
- (E2E uses fresh DB with no password — open access mode)

### 8b. Unit tests
- `npm test`
- **Expected:** All tests pass

### 8c. Type checking
- `npm run check`
- **Expected:** No errors

### 8d. Web build
- `npm run finalize:web`
- **Expected:** Clean build
