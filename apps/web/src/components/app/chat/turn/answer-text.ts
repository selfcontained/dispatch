import type { Block, ChatTurnEntry } from "@dispatch/shared";

/** The answer shown by a turn, including ACP text received after settlement. */
export function turnAnswerText(block: Block, turn: ChatTurnEntry): string {
  return turn.result?.text ?? (turn.settled ? block.text : "");
}
