// Keep existing UTF-16 display budgets without creating lone surrogates when
// clipping well-formed text. Do not repair malformed retained/provider strings;
// generated boundary validation must still refuse those.
export function prefixUnits(text: string, limit: number): string {
  let end = Math.min(limit, text.length);
  if (end > 0 && end < text.length && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end--;
  return text.slice(0, end);
}
export function tailUnits(text: string, limit: number): string {
  let start = Math.max(0, text.length - limit);
  if (start > 0 && low(text.charCodeAt(start)) && high(text.charCodeAt(start - 1))) start++;
  return text.slice(start);
}
function high(code: number) { return code >= 0xd800 && code <= 0xdbff; }
function low(code: number) { return code >= 0xdc00 && code <= 0xdfff; }
