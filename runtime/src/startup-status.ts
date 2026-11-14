// Read-only client helper for the native startup launcher. No Harness, SQLite,
// provider setup, drafts, runtime replacement or command retries.
import { hubCommand } from "./hub-client.js";
import { validStatusSnapshot } from "./generated/contracts.js";
const [portText, ...extra] = process.argv.slice(2);
async function main() {
  if (extra.length || !portText || !/^[0-9]+$/.test(portText)) throw new Error();
  const status = await hubCommand(Number(portText), "status");
  if (!validStatusSnapshot(status) || status.chatId !== status.mainChatId || status.binding?.kind !== "main" || status.binding.machineId !== status.machineId) throw new Error();
  process.stdout.write(JSON.stringify({ hubId: status.hubId, chatId: status.mainChatId, machineId: status.machineId, cwd: status.binding.cwd }));
}
void main().catch(() => { process.stderr.write("Local hub unavailable; run deck serve first.\n"); process.exitCode = 1; });
