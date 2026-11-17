# Read-only selected-chat tool inventory

`status` and `TuiSnapshot` optionally carry the same bounded public projection:

```ts
toolInventory?: {
  chatId: string;
  hubMachineId?: string;
  workerMachineId?: string; // selected chat's assigned machine, possibly the hub
  builtins: { name: string; location: "hub" | "worker" | "environment" }[];
  mcp: {
    profileId: string;
    machineId: string;
    location: "hub" | "worker";
    workspace?: "task" | "fixed";
    revision: string;
    state: "enabled" | "not_granted" | "unavailable";
    tools: { name: string; alias: string }[];
  }[];
};
toolInventoryStatus?: "ready" | "unsupported" | "unavailable";
```

- **Missing inventory is unknown, never “no MCP”.** Old peers can omit both fields. An empty `mcp` array in a successfully observed inventory means there are no compatible approved profiles or saved grants for this chat, not that the hub has no other MCP configurations.
- Builtins come from the selected conversation's resolved `agent.tools`, not a hardcoded availability list, the installed registry, internal `callable` tools or unoffered deferred tools. Foreground subagent and explicit model/tool allowlists are respected.
- `hub` means execution/control at the hub; native file/shell tools use `worker` when the assigned machine differs from the hub. `environment` means Pi/embedded environment tools (including fallback CodingTools), not native-worker execution. Identical tool names do not establish provenance.
- MCP rows include only compatible approved profiles or this conversation's saved grants. Fixed-workspace hub services may be compatible with a remote task; unrelated host configurations are not exposed to task clients.
- `enabled` requires a matching grant and at least one alias actually in the model surface. Its tools are the **visible subset**, not every tool in an installed extension. It is **not** a server-health guarantee: offline workers can still have model-visible tools.
- `not_granted` lists compatible approved candidates and their prospective aliases, not model availability.
- `unavailable` covers missing/changed catalog revisions or incoherent grants/model selection/binding. Its tools are empty. A missing catalog revision has **no `workspace` field**: grants do not retain enough metadata to infer one. A changed revision can appear as a new `not_granted` row alongside the old `unavailable` grant row.
- No schemas, descriptions, command lines, paths, environment variables or credentials are exposed. Inventory reads never resolve an execution environment, probe workers/servers, start a server, grant tools or add an RPC/privilege.

Contract bounds: 128 builtins, 16 MCP rows (8 catalog + 8 saved grants), 16 tools per MCP row, 128-byte ASCII builtin/alias names, 64-byte MCP names, 32-character MCP profile IDs, 32-hex MCP machine IDs, 64-hex revisions and 200-byte ASCII optional machine labels. The semantic projection/validation also caps the aggregate inventory at 64 KiB, validates the selected chat ID and rejects duplicate names/rows and contradictory status/payload combinations. Overlarge/unprojectable data becomes unavailable, not a silently clipped complete-looking inventory.

The client samples on selection and at most once every two seconds during poll/latest, including held/historical views. Refresh failures clear the previous inventory and set `unavailable`; omitted legacy metadata sets `unsupported`. A later successful read recovers automatically. Only existing scoped `status` reads are used. This observation does not gate model settings or input and never retries an effect.
