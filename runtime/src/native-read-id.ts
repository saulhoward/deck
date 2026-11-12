// One ephemeral namespace shared by all native read-only adapters in this process.
let next = 1n << 63n;
export function nativeReadId(): string {
  if (next >= 1n << 64n) throw new Error("Native read correlation exhausted; restart only after settling work");
  return String(next++);
}
