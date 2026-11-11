// Operator registration and handshake claims, not peer authentication. Only the
// native transport can supply observed socket identity to the connection gate.
import { validRemoteRegistry, validRemoteWorkerHello, validTailPeer, type RemoteRegistry, type RemoteWorkerHello, type TailPeer } from "./generated/contracts.js";
export function validPeer(value: unknown): value is TailPeer {
  return validTailPeer(value) && /^(0|[1-9][0-9]*)$/.test(value.userId) && BigInt(value.userId) <= 18446744073709551615n;
}
function ordered(values: string[]): boolean {
  const order = ["files", "bash", "rex"]; let previous = -1;
  for (const value of values) { const index = order.indexOf(value); if (index <= previous) return false; previous = index; }
  return true;
}
export function validRegistry(value: unknown): value is RemoteRegistry {
  if (!validRemoteRegistry(value)) return false;
  const machines = new Set<string>(); const nodes = new Set<string>();
  for (const host of value.hosts) {
    if (!validPeer(host.peer) || machines.has(host.machineId) || nodes.has(host.peer.nodeId) ||
        (host.implementation === undefined) !== (host.capabilities === undefined) ||
        (!host.client && !host.implementation) || (host.capabilities && !ordered(host.capabilities))) return false;
    machines.add(host.machineId); nodes.add(host.peer.nodeId);
  }
  return true;
}
export function validHello(value: unknown): value is RemoteWorkerHello {
  return validRemoteWorkerHello(value) && ordered(value.capabilities);
}
