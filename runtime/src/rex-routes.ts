// Preallocated native transport descriptors, dynamically registered workers.
// Pi remains the only store/execution owner. Unready routes return offline;
// registration never migrates a chat or replays an effect.
import { fstatSync } from "node:fs";
import { PipeFiles } from "./host-files.js";
import { RoutedFiles } from "./remote-files.js";
import { validRexRegistration, sameRexRegistration } from "./remote-contracts.js";
import { validRexRuntimeRoutes, type RexRuntimeRoutes, type RexWorkerRegistration, type WorkerHandoffPlan } from "./generated/contracts.js";
export function parseRexRoutes(bytes: string, localMachine: string, reserved: number[]): RexRuntimeRoutes {
  const value: unknown = JSON.parse(bytes);
  if (!validRexRuntimeRoutes(value)) throw new Error("Invalid automatic native routes");
  const machines = new Set([localMachine]), fds = new Set(reserved);
  if ((value.handoffReadFd === undefined) !== (value.handoffWriteFd === undefined)) throw new Error("Incomplete worker upgrade channel");
  for (const fd of value.handoffReadFd === undefined ? [] : [value.handoffReadFd, value.handoffWriteFd!]) {
    if (fds.has(fd)) throw new Error("Duplicate upgrade descriptor");
    const info = fstatSync(fd); if (!info.isFIFO() && !info.isSocket()) throw new Error("Invalid upgrade pipe");
    fds.add(fd);
  }
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
  const pending = new Set<string>();
  for (const { plan, phase } of value.handoffs ?? []) {
    if (phase !== "prepared" && phase !== "committed") throw new Error("Released handoff is not a runtime fence");
    const r = value.slots.find(s => s.registration?.machineId === plan.machineId)?.registration;
    const client = phase === "prepared" ? plan.beforeClient : plan.client;
    if (value.handoffReadFd === undefined || !r || pending.has(plan.machineId) || plan.hubId !== value.hubId || r.capabilities.join(",") !== "files,bash,rex,launcher" || r.implementation !== (phase === "prepared" ? plan.beforeImplementation : plan.implementation) || r.rexClient.executable !== client.executable || r.rexClient.socket !== client.socket || plan.client.socket !== plan.beforeClient.socket) throw new Error("Invalid retained worker handoff");
    pending.add(plan.machineId);
  }
  return value;
}
export class RexRoutedFiles extends RoutedFiles {
  private readonly slots: { pipe: PipeFiles; registration: RexWorkerRegistration | undefined; activated: boolean }[] = [];
  constructor(machineId: string, local: PipeFiles, readonly routes: RexRuntimeRoutes) {
    super(machineId, local, { hubId: routes.hubId ?? "not-yet-bound", hosts: [] });
    try {
      for (const slot of routes.slots) {
        const pipe = new PipeFiles(slot.readFd, slot.writeFd, slot.controlFd);
        this.slots.push({ pipe, registration: slot.registration, activated: false });
        if (slot.registration) this.addTransport(slot.registration.machineId, pipe, slot.registration.rexClient, slot.registration.capabilities.includes("mcp"), true);
      }
    } catch (error) { void this.close(); throw error; }
  }
  registration(index: number) { return this.slots[index]?.registration; }
  private readonly handoffs = new Map<string, string>();
  hasHandoff(plan: WorkerHandoffPlan) { return this.handoffs.get(plan.machineId) === plan.id; }
  checkHandoff(plan: WorkerHandoffPlan) {
    const slot = this.slots.find(s => s.registration?.machineId === plan.machineId);
    if (!slot?.registration || slot.registration.hubId !== plan.hubId || (this.handoffs.has(plan.machineId) && this.handoffs.get(plan.machineId) !== plan.id)) throw new Error("Unknown worker transition");
    const r = slot.registration;
    if (r.implementation !== plan.beforeImplementation || r.rexClient.executable !== plan.beforeClient.executable || r.rexClient.socket !== plan.beforeClient.socket || plan.client.socket !== r.rexClient.socket || r.capabilities.join(",") !== "files,bash,rex,launcher") throw new Error("Worker transition scope changed");
  }
  pauseHandoff(plan: WorkerHandoffPlan) {
    const slot = this.slots.find(s => s.registration?.machineId === plan.machineId)!;
    if (!slot.pipe.drained) return false;
    this.handoffs.set(plan.machineId, plan.id); this.pauseTransport(plan.machineId); return true;
  }
  restoreHandoff(plan: WorkerHandoffPlan) { this.handoffs.set(plan.machineId, plan.id); this.pauseTransport(plan.machineId); }
  commitHandoff(plan: WorkerHandoffPlan, registration: RexWorkerRegistration) {
    const slot = this.slots.find(s => s.registration?.machineId === plan.machineId);
    if (!slot || this.handoffs.get(plan.machineId) !== plan.id || !slot.pipe.drained || !validRexRegistration(registration) || registration.hubId !== plan.hubId || registration.machineId !== plan.machineId || registration.implementation !== plan.implementation || registration.rexClient.executable !== plan.client.executable || registration.rexClient.socket !== plan.client.socket) throw new Error("Unfenced worker commit");
    this.replaceClient(plan.machineId, registration.rexClient); slot.registration = registration;
  }
  cancelHandoff(plan: WorkerHandoffPlan) {
    if (this.handoffs.has(plan.machineId) && this.handoffs.get(plan.machineId) !== plan.id) throw new Error("Worker transition changed");
    this.handoffs.delete(plan.machineId); this.activateTransport(plan.machineId);
  }
  finishHandoff(plan: WorkerHandoffPlan) { this.cancelHandoff(plan); }
  register(index: number, registration: RexWorkerRegistration) {
    const slot = this.slots[index];
    if (!slot || slot.activated || !validRexRegistration(registration) || !registration.hubId || this.routes.hubId !== undefined && registration.hubId !== this.routes.hubId) throw new Error("Invalid native registration transition");
    if (slot.registration) {
      if (!sameRexRegistration(slot.registration, registration) || slot.registration.hubId !== registration.hubId) throw new Error("Worker registration changed");
    } else this.addTransport(registration.machineId, slot.pipe, registration.rexClient, registration.capabilities.includes("mcp"), true);
    slot.registration = registration; slot.activated = true;
    if (!this.handoffs.has(registration.machineId)) this.activateTransport(registration.machineId);
  }
  override async close() { await Promise.all([super.close(), ...this.slots.map(slot => slot.pipe.close())]); }
}
