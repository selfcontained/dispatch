import { siClaude } from "simple-icons";

import { cn } from "@/lib/utils";

type AgentEventType = "working" | "blocked" | "waiting_user" | "done" | "idle";

type AgentTypeIconProps = {
  type?: string | null;
  className?: string;
  eventType?: AgentEventType | null;
};

const eventColorClass: Record<AgentEventType, string> = {
  working: "text-status-working border-status-working/50 bg-status-working/15",
  blocked: "text-status-blocked border-status-blocked/50 bg-status-blocked/15",
  waiting_user: "text-status-waiting border-status-waiting/50 bg-status-waiting/15",
  done: "text-status-done border-status-done/50 bg-status-done/15",
  idle: "",
};

const CODEX_LOGO_PATH =
  "M60.8734,57.2556v-14.9432c0-1.2586.4722-2.2029,1.5728-2.8314l30.0443-17.3023c4.0899-2.3593,8.9662-3.4599,13.9988-3.4599,18.8759,0,30.8307,14.6289,30.8307,30.2006,0,1.1007,0,2.3593-.158,3.6178l-31.1446-18.2467c-1.8872-1.1006-3.7754-1.1006-5.6629,0l-39.4812,22.9651ZM131.0276,115.4561v-35.7074c0-2.2028-.9446-3.7756-2.8318-4.8763l-39.481-22.9651,12.8982-7.3934c1.1007-.6285,2.0453-.6285,3.1458,0l30.0441,17.3024c8.6523,5.0341,14.4708,15.7296,14.4708,26.1107,0,11.9539-7.0769,22.965-18.2461,27.527v.0021ZM51.593,83.9964l-12.8982-7.5497c-1.1007-.6285-1.5728-1.5728-1.5728-2.8314v-34.6048c0-16.8303,12.8982-29.5722,30.3585-29.5722,6.607,0,12.7403,2.2029,17.9324,6.1349l-30.987,17.9324c-1.8871,1.1007-2.8314,2.6735-2.8314,4.8764v45.6159l-.0014-.0015ZM79.3562,100.0403l-18.4829-10.3811v-22.0209l18.4829-10.3811,18.4812,10.3811v22.0209l-18.4812,10.3811ZM91.2319,147.8591c-6.607,0-12.7403-2.2031-17.9324-6.1344l30.9866-17.9333c1.8872-1.1005,2.8318-2.6728,2.8318-4.8759v-45.616l13.0564,7.5498c1.1005.6285,1.5723,1.5728,1.5723,2.8314v34.6051c0,16.8297-13.0564,29.5723-30.5147,29.5723v.001ZM53.9522,112.7822l-30.0443-17.3024c-8.652-5.0343-14.471-15.7296-14.471-26.1107,0-12.1119,7.2356-22.9652,18.403-27.5272v35.8634c0,2.2028.9443,3.7756,2.8314,4.8763l39.3248,22.8068-12.8982,7.3938c-1.1007.6287-2.045.6287-3.1456,0ZM52.2229,138.5791c-17.7745,0-30.8306-13.3713-30.8306-29.8871,0-1.2585.1578-2.5169.3143-3.7754l30.987,17.9323c1.8871,1.1005,3.7757,1.1005,5.6628,0l39.4811-22.807v14.9435c0,1.2585-.4721,2.2021-1.5728,2.8308l-30.0443,17.3025c-4.0898,2.359-8.9662,3.4605-13.9989,3.4605h.0014ZM91.2319,157.296c19.0327,0,34.9188-13.5272,38.5383-31.4594,17.6164-4.562,28.9425-21.0779,28.9425-37.908,0-11.0112-4.719-21.7066-13.2133-29.4143.7867-3.3035,1.2595-6.607,1.2595-9.909,0-22.4929-18.2471-39.3247-39.3251-39.3247-4.2461,0-8.3363.6285-12.4262,2.045-7.0792-6.9213-16.8318-11.3254-27.5271-11.3254-19.0331,0-34.9191,13.5268-38.5384,31.4591C11.3255,36.0212,0,52.5373,0,69.3675c0,11.0112,4.7184,21.7065,13.2125,29.4142-.7865,3.3035-1.2586,6.6067-1.2586,9.9092,0,22.4923,18.2466,39.3241,39.3248,39.3241,4.2462,0,8.3362-.6277,12.426-2.0441,7.0776,6.921,16.8302,11.3251,27.5271,11.3251Z";

function normalizeAgentType(type?: string | null): "codex" | "claude" | "opencode" | "unknown" {
  if (type === "claude") {
    return "claude";
  }
  if (type === "opencode") {
    return "opencode";
  }
  if (type === "codex" || !type) {
    return "codex";
  }
  return "unknown";
}

export function AgentTypeIcon({ type, className, eventType }: AgentTypeIconProps): JSX.Element {
  const normalizedType = normalizeAgentType(type);
  const label =
    normalizedType === "claude" ? "Claude" : normalizedType === "opencode" ? "OpenCode" : "Codex";
  const statusClass = eventType ? eventColorClass[eventType] : "";
  const baseClass = statusClass
    ? "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors duration-300"
    : "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground transition-colors duration-300";

  if (normalizedType === "opencode") {
    return (
      <span
        className={cn(
          baseClass,
          statusClass,
          "text-[9px] font-semibold tracking-[0.08em]",
          className
        )}
        title={`${label} agent`}
        aria-label={`${label} agent`}
      >
        OC
      </span>
    );
  }

  const logoPath = normalizedType === "claude" ? siClaude.path : CODEX_LOGO_PATH;
  const viewBox = normalizedType === "claude" ? "0 0 24 24" : "0 0 158.7128 157.296";

  return (
    <span
      className={cn(baseClass, statusClass, className)}
      title={`${label} agent`}
      aria-label={`${label} agent`}
    >
      <svg
        viewBox={viewBox}
        className="h-3.5 w-3.5"
        fill="currentColor"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: `<path d="${logoPath}" />` }}
      />
    </span>
  );
}
