// Auth-only native entry logic. No Harness, generation, model call or op lookup.
import { fstatSync } from "node:fs";
import { join } from "node:path";
import { FileCredentials } from "./credentials.js";
import { oauthLogin } from "./providers.js";
import { loginClient } from "./login-client.js";
import { hubCommand } from "./hub-client.js";
import { validStatusSnapshot } from "./generated/contracts.js";

const defaults = { command: hubCommand, client: loginClient, makeLogin: oauthLogin };
export async function runLogin(args: string[], dependencies: typeof defaults = defaults) {
  const [mode, directory, machineId, descriptor, rawPort] = args;
  if (!directory || !machineId || !/^[a-f0-9]{32}$/.test(machineId) || (mode !== "offline" && mode !== "online")) throw new Error("Invalid login launch");
  process.env.PI_OAUTH_CALLBACK_HOST = "127.0.0.1";
  if (mode === "online") {
    const port = Number(rawPort);
    const status = await dependencies.command(port, "status");
    if (!validStatusSnapshot(status) || status.machineId !== machineId || status.hubGuard !== 1) throw new Error("Wrong or incompatible hub; no login requested");
    process.stderr.write("deck: authenticating through the running hub; an existing API-key selection remains active until restart\n");
    await dependencies.client(async (name, args = {}) => await dependencies.command(port, name, args, status.hubId) as Record<string, unknown>);
    return;
  }
  const fd = Number(descriptor);
  if (!Number.isSafeInteger(fd) || fd < 3 || !fstatSync(fd).isFile()) throw new Error("Offline login requires native writer lock");
  const login = dependencies.makeLogin(new FileCredentials(join(directory, "auth.json")), machineId);
  try {
    process.stderr.write("deck: offline ChatGPT OAuth login; no agent work is started\n");
    await dependencies.client(async (name, args = {}) => {
      switch (name) {
        case "login_start": return login.start(String(args.requestId));
        case "login_status": return login.snapshot();
        case "login_reply": return login.answer(String(args.loginId), String(args.promptId), String(args.answer));
        case "login_cancel": return login.cancel(String(args.loginId));
        default: throw new Error("Invalid offline login command");
      }
    });
  } finally { await login.close(); }
  // Native inherited descriptor stays open until this process exits.
}
