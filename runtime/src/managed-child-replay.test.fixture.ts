// Subprocess crash windows; never shipped in the installed runtime payload.
import { writeFile, rename } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { setup } from "./managed-child.test.support.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
const [kind, path] = process.argv.slice(2) as [string, string];
const f = setup(), runtime = await f.open(path);
setInterval(() => {}, 1000);
async function checkpoint(value: object) {
  await writeFile(`${path}.checkpoint.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.checkpoint.tmp`, `${path}.checkpoint`);
}
const parent = await runtime.createTask("Parent", f.options.binding, "parent"), parentId = String(parent.id);
const child = await runtime.createManagedChild(parentId, "Managed", "create-managed", { problem: "Own problem", description: "Own immutable task" }), childId = String(child.id);
if (kind === "create") {
  await checkpoint({ parentId, childId }); await new Promise(() => {});
} else {
  const admit = runtime.admit.bind(runtime);
  runtime.admit = async (...args) => {
    const submission = await admit(...args);
    if (args[0] === parentId) {
      await checkpoint({ parentId, childId, submissionId: String(submission.id), input: args[1] });
      await new Promise(() => {});
    }
    return submission;
  };
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("parent_message", { text: "REPORT" }), { stopReason: "toolUse" }),
    async () => { await new Promise(() => {}); return fauxAssistantMessage("Unreachable before kill"); },
  ]);
  await (await runtime.admit(childId, { requestId: "human-start", text: "Report", mode: "followUp" })).wait(context);
}
