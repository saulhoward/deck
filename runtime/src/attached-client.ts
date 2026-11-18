// Client-only current-terminal attachment over the approved worker launcher.
// No terminal allocation, startup registration, new task, or effect retry.
import { randomUUID } from "node:crypto";
import { launcherCommand, type LauncherTarget } from "./launcher-client.js";
import { attachedRequest } from "./attachment-contracts.js";
import { HubError, responseResult } from "./responses.js";
import { validLauncherTaskReply } from "./generated/contracts.js";
export async function attachedCommand(target: LauncherTarget, chatId: string, command: string, args: Record<string, unknown>, expectedHubId?: string, signal?: AbortSignal): Promise<unknown> {
  const id = randomUUID();
  const body = JSON.stringify({ version: 1, id, command, args, hubId: target.hubId });
  const request = attachedRequest(body, chatId, expectedHubId);
  if (expectedHubId !== target.hubId || !request) throw new Error("Invalid attached task request; not sent");
  try {
    const result = await launcherCommand(target, { version: 1, id: randomUUID(), command: "launch_task", args: { chatId, body } }, signal);
    if (!validLauncherTaskReply(result)) throw new Error("Invalid task attachment response; outcome unconfirmed");
    return responseResult(JSON.parse(result.body), id, request);
  } catch (error) {
    // Preserve command-specific error policy, including bounded history paging.
    if (error instanceof HubError) throw new HubError(error.code, error.message, command);
    throw error;
  }
}
