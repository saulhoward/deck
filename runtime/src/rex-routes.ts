// Preallocated native transport descriptors, dynamically registered workers.
// Pi remains the only store/execution owner. Unready routes return offline;
// registration never migrates a chat or replays an effect.
import { fstatSync } from "node:fs";
import { PipeFiles } from "./host-files.js";
import { RoutedFiles } from "./remote-files.js";
import { validRexRegistration, sameRexRegistration } from "./remote-contracts.js";
import { validRexRuntimeRoutes, type RexRuntimeRoutes, type RexWorkerRegistration } from "./generated/contracts.js";
export function parseRexRoutes(bytes: string, localMachine: string, reserved: number[]): RexRuntimeRoutes {
  const value: unknown = JSON.parse(bytes);
  if (!validRexRuntimeRoutes(value)) throw new Error("Invalid automatic native routes");
  const machines = new Set([localMachine]), fds = new Set(reserved);
  for (const slot of value.slots) {
    const r = slot.registration;
    if (r) {
      if (!validRexRegistration(r) || !r.hubId || r.hubId !== value.hubId || machines.has(r.machineId)) throw new Error("Invalid saved automatic registration");
      machines.add(r.machineId);
    }
    for (const fd of [slot.readFd, slot.writeFd, slot.controlFd, slot.clientReadFd, slot.clientWriteFd]) {
      if (fds.has(fd)) throw new Error("Duplicate automatic descriptor");
      fds.add(fd);
      const stat = fstatSync(fd);
      if (!stat.isFIFO() && !stat.isSocket()) throw new Error("Invalid automatic pipe");
    }
  }
  return value;
}
export class RexRoutedFiles extends RoutedFiles {
  private readonly slots: { pipe: PipeFiles; registration: RexWorkerRegistration | undefined; activated: boolean }[] = [];
  constructor(machineId: string, local: PipeFiles, readonly routes: RexRuntimeRoutes) {
    super(machineId, local, { hubId: routes.hubId ?? "not-yet-bound", hosts: [] });
    try {
      for (const slot of routes.slots) {
        const pipe = new PipeFiles(slot.readFd, slot.writeFd, slot.controlFd, true);
        this.slots.push({ pipe, registration: slot.registration, activated: false });
        if (slot.registration) this.addTransport(slot.registration.machineId, pipe, slot.registration.rexClient, slot.registration.capabilities.includes("mcp"), true);
      }
    } catch (error) { void this.close(); throw error; }
  }
  register(index: number, registration: RexWorkerRegistration) {
    const slot = this.slots[index];
    if (!slot || slot.activated || !validRexRegistration(registration) || !registration.hubId || this.routes.hubId !== undefined && registration.hubId !== this.routes.hubId) throw new Error("Invalid native registration transition");
    if (slot.registration) {
      if (!sameRexRegistration(slot.registration, registration) || slot.registration.hubId !== registration.hubId) throw new Error("Worker registration changed");
    } else this.addTransport(registration.machineId, slot.pipe, registration.rexClient, registration.capabilities.includes("mcp"), true);
    slot.registration = registration; slot.activated = true;
    this.activateTransport(registration.machineId);
  }
  override async close() { await Promise.all([super.close(), ...this.slots.map(slot => slot.pipe.close())]); }
}
