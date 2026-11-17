// Read-only public projection of Pi's resolved model surface, not a registry or
// a health check. Never resolve an execution environment or contact an MCP server.
import type { Agent } from "@earendil-works/pi-durable";
import { grantKey, profileGrant, toolAlias } from "./mcp-tools.js";
import { type McpCatalog, type McpGrant, type McpProfile, type ToolInventory } from "./generated/contracts.js";
import { validToolInventory } from "./tool-inventory-contracts.js";

export function projectToolInventory(chatId: string, agent: Agent, catalog: McpCatalog, grants: readonly McpGrant[], hubMachineId: string | undefined, workerMachineId: string | undefined, allowed: (profile: McpProfile) => boolean): ToolInventory {
  const visible = new Set(agent.tools.map(tool => tool.name)); // NOT agent.callable/deferred.
  const granted = new Set(grants.map(grantKey));
  const aliases = new Set<string>();
  const mcp: ToolInventory["mcp"] = [];
  for (const profile of catalog.profiles) {
    const key = grantKey(profileGrant(profile));
    const tools = profile.tools.map(tool => ({ name: tool.name, alias: toolAlias(profile, tool.name) }));
    const offered = tools.filter(tool => visible.has(tool.alias));
    // An unrelated host's catalog must not leak through task-mode status. A
    // selected but incoherent extension is not an excuse to disclose its config.
    if (!allowed(profile) && !granted.has(key)) {
      if (offered.length) throw new Error("Unscoped MCP model surface");
      continue;
    }
    for (const tool of tools) aliases.add(tool.alias);
    const state = granted.has(key) ? allowed(profile) && offered.length ? "enabled" : "unavailable" : offered.length ? "unavailable" : "not_granted";
    mcp.push({ profileId: profile.id, machineId: profile.machineId, location: profile.machineId === hubMachineId ? "hub" : "worker", workspace: profile.workspace, revision: profile.revision, state, tools: state === "enabled" ? offered : state === "not_granted" ? tools : [] });
  }
  for (const grant of grants) {
    if (catalog.profiles.some(profile => grantKey(profileGrant(profile)) === grantKey(grant))) continue;
    // Grants deliberately contain no workspace or tool metadata. Never borrow
    // either from a different revision, or invent a workspace for a missing one.
    mcp.push({ ...grant, location: grant.machineId === hubMachineId ? "hub" : "worker", state: "unavailable", tools: [] });
  }
  const builtins: ToolInventory["builtins"] = [];
  for (const tool of agent.tools) {
    if (aliases.has(tool.name)) continue;
    let owner: string | undefined;
    for (const extension of agent.extensions) {
      if (extension.tools?.some(item => item.name === tool.name) || extension.wraps?.some(wrap => "tool" in wrap && wrap.tool === tool.name)) owner = extension.name;
    }
    if (owner?.startsWith("deck.mcp.")) throw new Error("Unresolved MCP model surface");
    // The native adapter and CodingTools have the SAME tool names. Provenance,
    // not the name or localFiles flag, determines where an invocation executes.
    const location = owner === "deck.native-files" ? (workerMachineId === hubMachineId ? "hub" : "worker") :
      ["deck.task-inspection", "deck.task-control", "deck.foreground-subagent"].includes(owner ?? "") ? "hub" : "environment";
    builtins.push({ name: tool.name, location });
  }
  const result: ToolInventory = { chatId, ...(hubMachineId ? { hubMachineId } : {}), ...(workerMachineId ? { workerMachineId } : {}), builtins, mcp };
  // Refuse overlarge/invalid metadata instead of silently clipping a supposedly
  // comprehensive inventory (or leaking a partially projected object).
  if (!validToolInventory(result)) throw new Error("Tool inventory unavailable");
  return result;
}
