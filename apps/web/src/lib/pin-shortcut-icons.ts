import {
  ArrowRight,
  Bug,
  Check,
  Clock,
  Database,
  Download,
  FileText,
  Flag,
  GitBranch,
  GitPullRequest,
  ListChecks,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Search,
  Shield,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Icons an agent may put on a shortcut pin. A fixed set rather than "any lucide
 * name" so the bundle only carries what we actually ship, and so the tool
 * schema can enumerate the choices for the agent.
 */
export const PIN_SHORTCUT_ICONS = {
  zap: Zap,
  play: Play,
  rocket: Rocket,
  refresh: RefreshCw,
  check: Check,
  x: X,
  pause: Pause,
  trash: Trash2,
  bug: Bug,
  search: Search,
  database: Database,
  terminal: Terminal,
  file: FileText,
  branch: GitBranch,
  "pull-request": GitPullRequest,
  message: MessageSquare,
  flag: Flag,
  clock: Clock,
  checklist: ListChecks,
  sparkles: Sparkles,
  wrench: Wrench,
  shield: Shield,
  upload: Upload,
  download: Download,
  arrow: ArrowRight,
} as const satisfies Record<string, LucideIcon>;

export type PinShortcutIcon = keyof typeof PIN_SHORTCUT_ICONS;

export function resolvePinShortcutIcon(name: string | undefined): LucideIcon {
  // Own-property check: `in` would match inherited keys, so "constructor" or
  // "__proto__" would resolve to something that is not a component and throw
  // during render instead of falling back.
  if (name && Object.hasOwn(PIN_SHORTCUT_ICONS, name)) {
    return PIN_SHORTCUT_ICONS[name as PinShortcutIcon];
  }
  return Zap;
}
