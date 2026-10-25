/** Fold one ASCII key into a Ctrl byte; preserve escape sequences and pasted text. */
export function applyCtrl(data: string): string {
  if (data.length !== 1) return data;
  let code = data.charCodeAt(0);
  if (code >= 97 && code <= 122) code -= 32;
  return code >= 64 && code <= 95 ? String.fromCharCode(code & 31) : data;
}
