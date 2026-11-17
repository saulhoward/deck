import { validToolInventory as validWireInventory, validToolInventoryStatus, type ToolInventory, type ToolInventoryStatus } from "./generated/contracts.js";
import { validSafePiId } from "./mutation-contracts.js";

export function validToolInventory(value: unknown, chatId?: string): value is ToolInventory {
  if (!validWireInventory(value) || !validSafePiId(value.chatId) || (chatId !== undefined && value.chatId !== chatId)) return false;
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) return false;
  const names = new Set<string>(), profiles = new Set<string>();
  for (const tool of value.builtins) {
    if (names.has(tool.name)) return false;
    names.add(tool.name);
  }
  for (const profile of value.mcp) {
    const key = `${profile.machineId}/${profile.profileId}/${profile.revision}`;
    if (profiles.has(key) || (profile.location === "hub" && value.hubMachineId !== undefined && profile.machineId !== value.hubMachineId)) return false;
    profiles.add(key);
    if (profile.state === "unavailable" ? profile.tools.length !== 0 : !profile.workspace || profile.tools.length === 0) return false;
    const toolNames = new Set<string>();
    for (const tool of profile.tools) {
      if (names.has(tool.alias) || toolNames.has(tool.name)) return false;
      names.add(tool.alias); toolNames.add(tool.name);
    }
  }
  return true;
}

// Legacy replies may omit both fields (unknown), or carry inventory without the
// convenience status. An explicit status must never contradict its payload.
export function validInventoryFields(value: { chatId: string; toolInventory?: ToolInventory; toolInventoryStatus?: ToolInventoryStatus }): boolean {
  return (value.toolInventory === undefined || validToolInventory(value.toolInventory, value.chatId)) &&
    (value.toolInventoryStatus === undefined || validToolInventoryStatus(value.toolInventoryStatus) && (value.toolInventoryStatus === "ready") === (value.toolInventory !== undefined));
}
