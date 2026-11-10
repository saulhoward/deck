import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";

// ChildProcess destroys its own .stdin when the supervisor exits. That races
// orphan-writer lock assertions against Pi's legitimate EOF shutdown. Give Pi
// an independently owned input stream so SIGKILL and EOF are separate actions.
export async function independentStdin() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test stdin address");
  const accepted = once(server, "connection");
  const writer = createConnection(address.port, "127.0.0.1");
  await once(writer, "connect");
  const [reader] = await accepted as [Socket];
  reader.pause();
  server.close();
  return { reader, writer, close() { writer.destroy(); reader.destroy(); } };
}
