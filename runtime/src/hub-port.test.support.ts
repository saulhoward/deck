import { randomInt } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";

// Default serve needs a hub/enrollment pair. Avoid the usual ephemeral client
// range: reserving listen(0), releasing it, then taking port+1 races the test
// runner's next outbound connection. This is a probe, not a readiness lease;
// callers still verify their own hub's identity after launch.
export async function freeHubPort(): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = randomInt(20000, 30000), first = createServer(), second = createServer();
    try {
      first.listen(port, "127.0.0.1"); await once(first, "listening");
      second.listen(port + 1, "127.0.0.1"); await once(second, "listening");
      return port;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; }
    finally {
      await Promise.all([first, second].map(server => server.listening ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve()));
    }
  }
  throw new Error("No isolated hub/enrollment port pair");
}
