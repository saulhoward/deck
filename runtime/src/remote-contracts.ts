// Operator registration and handshake claims, not peer authentication. Only the
// native transport can supply observed socket identity to the connection gate.
import { isAbsolute } from "node:path";
import { validRexWorkerRegistration, type RexWorkerRegistration } from "./generated/contracts.js";
export function validRexRegistration(value: unknown): value is RexWorkerRegistration {
  return validRexWorkerRegistration(value) && validRexClient(value.rexClient) && /^files,bash,rex(,mcp)?,launcher$/.test(value.capabilities.join(","));
}
export function sameRexRegistration(left: RexWorkerRegistration, right: RexWorkerRegistration): boolean {
  return left.machineId === right.machineId && left.implementation === right.implementation && left.capabilities.join(",") === right.capabilities.join(",") && left.rexClient.executable === right.rexClient.executable && left.rexClient.socket === right.rexClient.socket;
}
import { validTaskRelayFrame, type TaskRelayFrame, validWorkerRexClient, type WorkerRexClient, validRemoteRegistry, validRemoteWorkerHello, validTailPeer, type RemoteRegistry, type RemoteWorkerHello, type TailPeer } from "./generated/contracts.js";
export function validPeer(value: unknown): value is TailPeer {
  return validTailPeer(value) && /^(0|[1-9][0-9]*)$/.test(value.userId) && BigInt(value.userId) <= 18446744073709551615n;
}
function ordered(values: string[]): boolean {
  const order = ["files", "bash", "rex", "mcp", "launcher"]; let previous = -1;
  for (const value of values) { const index = order.indexOf(value); if (index <= previous) return false; previous = index; }
  return true;
}
export function validRexClient(value: unknown): value is WorkerRexClient {
  return validWorkerRexClient(value) && [value.executable, value.socket].every(s => isAbsolute(s) && !/[\0\r\n]/.test(s)) && Buffer.byteLength(value.executable) <= 4096 && Buffer.byteLength(value.socket) <= 100;
}
export function validRegistry(value: unknown): value is RemoteRegistry {
  if (!validRemoteRegistry(value)) return false;
  const machines = new Set<string>(); const nodes = new Set<string>();
  for (const host of value.hosts) {
    if (!validPeer(host.peer) || machines.has(host.machineId) || nodes.has(host.peer.nodeId) ||
        (host.implementation === undefined) !== (host.capabilities === undefined) ||
        (!host.client && !host.implementation) || (host.capabilities && !ordered(host.capabilities))) return false;
    if (host.capabilities?.includes("launcher") && !host.rexClient) return false;
    if (host.rexClient && (!validRexClient(host.rexClient) || !host.implementation || !/^files,bash,rex(,mcp)?(,launcher)?$/.test(host.capabilities?.join(",") ?? ""))) return false;
    machines.add(host.machineId); nodes.add(host.peer.nodeId);
  }
  return true;
}
export function validHello(value: unknown): value is RemoteWorkerHello {
  return validRemoteWorkerHello(value) && ordered(value.capabilities) && (!value.capabilities.includes("launcher") || !!value.rexClient) && (!value.rexClient || (validRexClient(value.rexClient) && /^files,bash,rex(,mcp)?(,launcher)?$/.test(value.capabilities.join(","))));
}
export function validWorkerFrame(value: unknown): value is TaskRelayFrame {
  return validTaskRelayFrame(value) && (value.scope !== undefined) !== (value.launcher !== undefined);
}
