import { once } from "node:events";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { bootstrapPath, bootstrapRecord, hereRecord, isHere, StartupFiles } from "./agent-storage.js";
import { AgentWizard, validWizardRequest, validWizardReply, wizardTransport } from "./agent-wizard.js";
const abort = new AbortController(), decoder = process.stdin.pipe(new FrameDecoder());
const stop = () => { abort.abort(); decoder.destroy(); };
process.stdin.on("end", stop); process.stdin.on("error", stop); process.stdout.on("error", stop);
async function main() {
  const [root, id, ...extra] = process.argv.slice(2);
  if (!root || !id || (extra.length && (extra.length !== 1 || extra[0] !== "--here"))) throw new Error();
  const record = extra.length ? await hereRecord(root, id) : await bootstrapRecord(root, id);
  const wizard = new AgentWizard(record, new StartupFiles(bootstrapPath(root, id)), wizardTransport(record, abort.signal));
  for await (const request of decoder) {
    if (abort.signal.aborted || !validWizardRequest(request)) break;
    const reply = await wizard.handle(request);
    if (abort.signal.aborted || !validWizardReply(reply, isHere(record))) break;
    if (!process.stdout.write(encodeFrame(reply))) await once(process.stdout, "drain", { signal: abort.signal });
  }
}
void main().catch(() => {}).finally(() => { stop(); process.stdin.destroy(); });
