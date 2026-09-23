/**
 * Wire types for the `/api/v1/history/*` routes.
 *
 * Kept dependency-free on purpose: apps/web imports these directly (type-only)
 * so each response shape is declared once instead of being hand-mirrored in
 * apps/web/src/hooks/use-agent-history.ts.
 */

export type HistoryChildAgent = {
  id: string;
  name: string;
  persona: string | null;
  status: string;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
};

export type HistoryTokenTotals = {
  total_input: number;
  total_cache_creation: number;
  total_cache_read: number;
  total_output: number;
  total_messages: number;
};

export type HistoryTokenByModel = {
  model: string;
  input_tokens: number;
  output_tokens: number;
};

export type HistoryTokenUsage = HistoryTokenTotals & {
  by_model: HistoryTokenByModel[];
};

export type HistoryFile = {
  id: number;
  file_name: string;
  source: string;
  size_bytes: number;
  description: string | null;
  created_at: string;
  mime_type: string;
};

export type HistoryFeedbackItem = {
  id: number;
  agentId: string;
  persona: string | null;
  severity: string;
  filePath: string | null;
  lineNumber: number | null;
  description: string;
  suggestion: string | null;
  fileRef: string | null;
  status: string;
  createdAt: string;
};
