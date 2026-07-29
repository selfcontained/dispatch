/**
 * IDE-type table and predicates, re-exported from the shared server module
 * so the web client always matches what the server accepts (see
 * apps/server/src/shared/ide-types.ts). Display labels live here.
 */
import type { IdeType } from "../../../server/src/shared/ide-types";

export {
  IDE_TYPES,
  isIdeType,
  sanitizeEnabledIdes,
  type IdeType,
} from "../../../server/src/shared/ide-types";

export const IDE_LABELS: Record<IdeType, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
};
