import { validRexServer } from "./generated/contracts.js";

// Keep retained endpoint spellings unchanged. Compare/limit decoded Unix paths,
// including Rex's percent-encoded default macOS Application Support directory.
export function rexSocketPath(value: string): string | undefined {
  if (!validRexServer(value) || !value.startsWith("unix:///") || /[?#\0\r\n]/.test(value)) return;
  try {
    const path = decodeURIComponent(value.slice(7));
    if (Buffer.byteLength(path) <= 100 && !/[\0\r\n]/.test(path)) return path;
  } catch { /* Invalid percent escapes/UTF-8 are not local endpoints. */ }
}
