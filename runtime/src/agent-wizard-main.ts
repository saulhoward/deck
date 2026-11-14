import { once } from "node:events";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { bootstrapPath, bootstrapRecord, StartupFiles } from "./agent-storage.js";
import { AgentWizard, validWizardRequest, wizardTransport } from "./agent-wizard.js";
import { validAgentWizardResponse } from "./generated/contracts.js";
const abort = new AbortController(), decoder = process.stdin.pipe(new FrameDecoder());
const stop = () => { abort.abort(); decoder.destroy(); };
process.stdin.on("end", stop); process.stdin.on("error", stop); process.stdout.on("error", stop);
async function main() {
  const [root, id, ...extra] = process.argv.slice(2);
  if (!root || !id || extra.length) throw new Error();
  const record = await bootstrapRecord(root, id);
  const wizard = new AgentWizard(record, new StartupFiles(bootstrapPath(root, id)), wizardTransport(record, abort.signal));
  for await (const request of decoder) {
    if (abort.signal.aborted || !validWizardRequest(request)) break;
    const reply = await wizard.handle(request);
    if (abort.signal.aborted || !validAgentWizardResponse(reply)) break;
    if (!process.stdout.write(encodeFrame(reply))) await once(process.stdout, "drain", { signal: abort.signal });
  }
}
void main().catch(() => {}).finally(() => { stop(); process.stdin.destroy(); });
