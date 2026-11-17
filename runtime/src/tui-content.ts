import type { HistoryEntry, TuiEntry, TuiPart } from "./generated/contracts.js";

export const entryBytes = 8192;
const maxParts = 256;

// Sanitize BEFORE slicing, especially for tails: an OSC/DCS payload must never
// become visible just because its introducer fell outside the display window.
// Unterminated control strings are discarded through EOF. Keep LF, expand TAB,
// and repair invalid surrogate sequences without changing the canonical entry.
export function sanitizeText(value: string): string {
  return value.toWellFormed()
    .replace(/(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$(?![\s\S]))/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?/g, "")
    .replace(/\x1b[ -/]*[0-~]?/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\t/g, "    ");
}
function sliceBytes(text: string, limit: number, tail = false): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  if (limit <= 0) return "";
  if (tail) {
    let start = bytes.length - limit;
    while ((bytes[start]! & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString();
  }
  let end = limit;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString();
}
// Legacy scalar display fields have no part provenance. History uses the
// structured projector below rather than embedding clipping markers in text.
export function displayText(value: string, bytes: number): string {
  const clean = sanitizeText(value);
  if (Buffer.byteLength(clean) <= bytes) return clean;
  const marker = "\n[view clipped]";
  return sliceBytes(clean, Math.max(0, bytes - Buffer.byteLength(marker))) + sliceBytes(marker, bytes);
}
// Only a provider-reported count, never reasoning text, signatures or estimates.
export function thinkingUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const { reasoning, output } = usage as { reasoning?: unknown; output?: unknown };
  return typeof reasoning === "number" && Number.isSafeInteger(reasoning) && reasoning > 0 && typeof output === "number" && Number.isSafeInteger(output) && reasoning <= output
    ? reasoning : undefined;
}
function toolHeading(part: TuiPart): string {
  return part.kind === "tool" ? `${part.toolName ?? ""}${part.isError ? " (error)" : ""}\n` : "";
}
export function flattenParts(parts: readonly TuiPart[]): string {
  return parts.map(part => toolHeading(part) + part.text).join("\n");
}

function boundParts(original: TuiPart[], failures: Set<TuiPart>, needsNotice: boolean): TuiPart[] {
  const clipped: TuiPart = { kind: "notice", text: "[view clipped]" };
  const required = (part: TuiPart) => failures.has(part) || part === clipped;
  const minimum = (part: TuiPart) => Buffer.byteLength(toolHeading(part)) + (required(part) ? Buffer.byteLength(part.text) : 0);
  let parts = original.slice();
  const addNotice = () => {
    // Keep failure status last and visible even after a long answer.
    let index = parts.length;
    while (index > 0 && failures.has(parts[index - 1]!)) index--;
    parts.splice(index, 0, clipped);
  };
  if (needsNotice) addNotice();
  const fitMetadata = () => {
    if (parts.length <= maxParts && parts.reduce((n, part) => n + minimum(part) + 1, -1) <= entryBytes) return;
    // If part count or headings alone exceed the budget, retain a bounded
    // prefix and explicitly report omissions. Reserve both distinct failure
    // outcomes, including failures beyond the omitted prefix.
    const selected: TuiPart[] = [];
    let used = 0;
    for (const part of original) {
      const size = minimum(part) + 1;
      if (selected.length >= maxParts - 3 || used + size > entryBytes - 64) break;
      selected.push(part); used += size;
    }
    const outcomes = new Map([...failures].map(part => [part.text, part]));
    parts = [...selected, clipped, ...[...outcomes.values()].filter(part => !selected.some(item => failures.has(item) && item.text === part.text))];
  };
  for (;;) {
    fitMetadata();
    // Fair allocation retains every selected tool-result message, not only the
    // first large output. Short labels/failures consume their full requirement;
    // large bodies share the remaining bytes. Bash bodies retain their TAIL.
    let remaining = entryBytes - Math.max(0, parts.length - 1);
    const sizes = parts.map(part => {
      remaining -= Buffer.byteLength(toolHeading(part));
      const size = required(part) ? Buffer.byteLength(part.text) : 0;
      remaining -= size;
      return size;
    });
    let pending = parts.flatMap((part, i) => required(part) ? [] : [i]);
    while (pending.length) {
      const share = Math.floor(remaining / pending.length);
      const small = pending.filter(i => Buffer.byteLength(parts[i]!.text) <= share);
      if (small.length) {
        for (const i of small) { sizes[i] = Buffer.byteLength(parts[i]!.text); remaining -= sizes[i]!; }
        const filled = new Set(small);
        pending = pending.filter(i => !filled.has(i));
      } else {
        let extra = remaining % pending.length;
        for (const i of pending) sizes[i] = share + (extra-- > 0 ? 1 : 0);
        break;
      }
    }
    const nonToolClipped = parts.some((part, i) => part.kind !== "tool" && Buffer.byteLength(part.text) > sizes[i]!);
    if (nonToolClipped && !parts.includes(clipped)) { addNotice(); continue; }
    return parts.map((part, i) => {
      if (Buffer.byteLength(part.text) <= sizes[i]!) return part;
      return { ...part, text: sliceBytes(part.text, sizes[i]!, part.kind === "tool" && part.toolName === "bash"), ...(part.kind === "tool" ? { clipped: true } : {}) };
    });
  }
}

// History is validated at the HTTP boundary but model messages are intentionally
// opaque/extensible. Project only allowlisted content, never stringify blocks,
// arguments, signatures, images, provider diagnostics or hidden reasoning.
export function projectEntry(entry: HistoryEntry): TuiEntry {
  let role: TuiEntry["role"] = "note", thinkingTokens = 0, needsNotice = false;
  const parts: TuiPart[] = [], failures = new Set<TuiPart>();
  const text = (value: unknown) => typeof value === "string" ? sanitizeText(value) : "";
  const name = (value: unknown) => {
    const clean = text(value);
    return { value: sliceBytes(clean, 128), clipped: Buffer.byteLength(clean) > 128 };
  };
  const notice = (value: string) => { const part: TuiPart = { kind: "notice", text: text(value) }; parts.push(part); return part; };
  if (entry.kind === "deck.input") {
    role = "user";
    const data = entry.data as any;
    if (data?.origin?.kind === "task-tool") {
      role = "note";
      notice(`[agent chat ${data.origin.chatId}, task ${data.origin.taskId}${data.origin.chain ? `; request ${data.requestId}; reply ${data.origin.chain.replyToChatId}/${data.origin.chain.replyToRequestId}; hop ${data.origin.chain.hop}/8` : ""}]`);
    }
    parts.push({ kind: "text", text: text(data?.text) });
  } else if (entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") {
    role = entry.kind === "pi.assistant" ? "assistant" : "tool";
    for (const message of (Array.isArray(entry.model) ? entry.model : []) as any[]) {
      if (!message || typeof message !== "object") continue;
      const content: any[] = Array.isArray(message.content) ? message.content : [];
      if (role === "tool") {
        const toolName = name(message.toolName);
        parts.push({ kind: "tool", toolName: toolName.value, isError: message.isError === true,
          text: text(content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n")),
          ...(toolName.clipped ? { clipped: true } : {}) });
      } else {
        thinkingTokens += thinkingUsage(message.usage) ?? 0;
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") parts.push({ kind: "text", text: text(block.text) });
          else if (block?.type === "toolCall") {
            const toolName = name(block.name);
            needsNotice ||= toolName.clipped;
            parts.push({ kind: "tool_request", toolName: toolName.value, text: `[tool requested: ${toolName.value}]` });
          }
        }
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") failures.add(notice(`[${message.stopReason}]`));
    }
  } else notice(`[${entry.kind}: retained entry, not rendered]`);
  const bounded = boundParts(parts, failures, needsNotice);
  return { id: entry.id, role, text: flattenParts(bounded), parts: bounded,
    ...(thinkingTokens > 0 && Number.isSafeInteger(thinkingTokens) ? { thinkingTokens } : {}) };
}
