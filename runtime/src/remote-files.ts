// Routing only. Zig owns the actual sockets, peer checks, generation fencing and
// native receipts. No Pi store, effects queue, execution retry or host fallback.
import { fstatSync } from "node:fs";
import { PipeFiles, type HostFiles, type FileResult, type ShellProgress } from "./host-files.js";
import type { Binding } from "./deck.js";
import { validRexClient } from "./remote-contracts.js";
import { nativeReadId } from "./native-read-id.js";
import type { HostItem } from "./generated/contracts.js";
import { validRemoteRuntimeRoutes, type WorkerRexClient, type RemoteRuntimeRoutes, type NativeArguments } from "./generated/contracts.js";
export function parseRoutes(bytes: string, localMachine: string, reserved: number[]): RemoteRuntimeRoutes {
  const value: unknown = JSON.parse(bytes);
  if (!validRemoteRuntimeRoutes(value)) throw new Error("Invalid native worker routes");
  const machines = new Set([localMachine]), fds = new Set(reserved);
  for (const host of value.hosts) {
    if (machines.has(host.machineId)) throw new Error("Duplicate native worker route");
    if (host.launcher !== undefined && (host.launcher !== true || !host.rexClient)) throw new Error("Invalid launcher route");
    machines.add(host.machineId);
    if (!!host.rexClient !== (host.clientReadFd !== undefined && host.clientWriteFd !== undefined) || (!host.rexClient && (host.clientReadFd !== undefined || host.clientWriteFd !== undefined)) || (host.rexClient && !validRexClient(host.rexClient))) throw new Error("Invalid worker client route");
    for (const fd of [host.readFd, host.writeFd, host.controlFd, ...(host.rexClient ? [host.clientReadFd!, host.clientWriteFd!] : [])]) {
      if (fds.has(fd)) throw new Error("Duplicate native worker descriptor"); fds.add(fd);
    }
  }
  return value;
}
export class RoutedFiles implements HostFiles {
  private readonly remotes = new Map<string, PipeFiles>();
  private readonly clients = new Map<string, WorkerRexClient>();
  private readonly mcp = new Set<string>();
  rexClientFor(machineId: string) { return this.clients.get(machineId); }
  private readonly observing = new Set<string>();
  async registeredHosts(): Promise<HostItem[]> {
    return Promise.all([...this.remotes].map(async ([machineId, pipe]): Promise<HostItem> => {
      let connection: HostItem["connection"] = "unknown";
      if (!this.observing.has(machineId)) {
        this.observing.add(machineId);
        // One retained read correlation per route, even when callers time out.
        // Consume late replies, never cache them as a fresh availability lease.
        const sample = Promise.resolve().then(() => pipe.call({ machineId, cwd: "/" }, nativeReadId(), "link_status", {})).then((reply): HostItem["connection"] => reply.ok && reply.code === "link_status" && (reply.output === "connected" || reply.output === "offline") ? reply.output : "unknown", () => "unknown" as const).finally(() => this.observing.delete(machineId));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { connection = await Promise.race([sample, new Promise<"unknown">(resolve => { timer = setTimeout(() => resolve("unknown"), 2000); })]); }
        finally { clearTimeout(timer); }
      }
      return { machineId, kind: "worker", rex: this.clients.has(machineId), connection };
    }));
  }
  constructor(private readonly machineId: string, private readonly local: PipeFiles, routes: RemoteRuntimeRoutes) {
    for (const host of routes.hosts) for (const fd of [host.readFd, host.writeFd, host.controlFd, ...(host.rexClient ? [host.clientReadFd!, host.clientWriteFd!] : [])]) {
      const stat = fstatSync(fd); if (!stat.isFIFO() && !stat.isSocket()) throw new Error("Invalid native worker pipe");
    }
    try { for (const host of routes.hosts) { if (host.mcp) this.mcp.add(host.machineId); this.remotes.set(host.machineId, new PipeFiles(host.readFd, host.writeFd, host.controlFd, true)); if (host.rexClient) this.clients.set(host.machineId, host.rexClient); } }
    catch (error) { for (const remote of this.remotes.values()) void remote.close(); throw error; }
  }
  call(binding: Binding, id: string, operation: string, args: NativeArguments, signal?: AbortSignal, onProgress?: (progress: ShellProgress) => void): Promise<FileResult> {
    if (binding.machineId === this.machineId) return this.local.call(binding, id, operation, args, signal, onProgress);
    signal?.throwIfAborted();
    if(operation==="mcp_call") {
      let plan: unknown; try { plan=JSON.parse(args.plan??""); } catch { throw new Error("Invalid MCP request; not sent"); }
      if(!plan || typeof plan!=="object" || (plan as {taskMachineId?:unknown}).taskMachineId!==binding.machineId) return Promise.resolve({ok:false,code:"mcp_refused",output:"MCP worker differs from assigned host; no fallback"});
    }
    const remote = this.remotes.get(binding.machineId);
    if (!remote || (operation === "mcp_call" ? !this.mcp.has(binding.machineId) : !this.clients.has(binding.machineId) && !["read", "write", "edit", "bash"].includes(operation))) return Promise.resolve({ ok: false, code: "offline", output: "offline: assigned worker/capability unavailable; this attempt was not sent; earlier attempts may have happened; no local fallback" });
    return remote.call(binding, id, operation, args, signal, onProgress);
  }
  async close(): Promise<void> { await Promise.all([this.local.close(), ...[...this.remotes.values()].map(remote => remote.close())]); }
}
