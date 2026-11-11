// Routing only. Zig owns the actual sockets, peer checks, generation fencing and
// native receipts. No Pi store, effects queue, execution retry or host fallback.
import { fstatSync } from "node:fs";
import { PipeFiles, type HostFiles, type FileResult, type ShellProgress } from "./host-files.js";
import type { Binding } from "./deck.js";
import { validRemoteRuntimeRoutes, type RemoteRuntimeRoutes, type NativeArguments } from "./generated/contracts.js";
export function parseRoutes(bytes: string, localMachine: string, reserved: number[]): RemoteRuntimeRoutes {
  const value: unknown = JSON.parse(bytes);
  if (!validRemoteRuntimeRoutes(value)) throw new Error("Invalid native worker routes");
  const machines = new Set([localMachine]), fds = new Set(reserved);
  for (const host of value.hosts) {
    if (machines.has(host.machineId)) throw new Error("Duplicate native worker route");
    machines.add(host.machineId);
    for (const fd of [host.readFd, host.writeFd, host.controlFd]) {
      if (fds.has(fd)) throw new Error("Duplicate native worker descriptor"); fds.add(fd);
    }
  }
  return value;
}
export class RoutedFiles implements HostFiles {
  private readonly remotes = new Map<string, PipeFiles>();
  constructor(private readonly machineId: string, private readonly local: PipeFiles, routes: RemoteRuntimeRoutes) {
    for (const host of routes.hosts) for (const fd of [host.readFd, host.writeFd, host.controlFd]) {
      const stat = fstatSync(fd); if (!stat.isFIFO() && !stat.isSocket()) throw new Error("Invalid native worker pipe");
    }
    try { for (const host of routes.hosts) this.remotes.set(host.machineId, new PipeFiles(host.readFd, host.writeFd, host.controlFd, true)); }
    catch (error) { for (const remote of this.remotes.values()) void remote.close(); throw error; }
  }
  call(binding: Binding, id: string, operation: string, args: NativeArguments, signal?: AbortSignal, onProgress?: (progress: ShellProgress) => void): Promise<FileResult> {
    if (binding.machineId === this.machineId) return this.local.call(binding, id, operation, args, signal, onProgress);
    signal?.throwIfAborted();
    const remote = this.remotes.get(binding.machineId);
    if (!remote || !["read", "write", "edit", "bash"].includes(operation)) return Promise.resolve({ ok: false, code: "offline", output: "offline: assigned worker/capability unavailable; this attempt was not sent; earlier attempts may have happened; no local fallback" });
    return remote.call(binding, id, operation, args, signal, onProgress);
  }
  async close(): Promise<void> { await Promise.all([this.local.close(), ...[...this.remotes.values()].map(remote => remote.close())]); }
}
