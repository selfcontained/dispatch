import { createClientId } from "@/lib/client-id";

/**
 * This page's app session: one id per tab or installed app window, shared by
 * its event stream and its presence heartbeats so the server can address
 * that one session (an in-app toast) and know what it is showing.
 */
export const APP_SESSION_ID = `ses_${createClientId()}`;
