import { validHostInventory, type HostInventory } from "./generated/contracts.js";
export function validHosts(value: unknown): value is HostInventory {
  return validHostInventory(value) && value.items.filter(h => h.kind === "local").length <= 1 && new Set(value.items.map(h => h.machineId)).size === value.items.length && value.items.every(h => (h.kind === "local") === (h.connection === "local"));
}
export function validHostArgs(command: string, value: unknown): boolean {
  return command !== "list_hosts" || (!!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}
export function validHostReply(command: string, value: unknown): boolean { return command !== "list_hosts" || validHosts(value); }
