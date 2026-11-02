import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function clientEnv() {
  const directory = await mkdtemp(join(tmpdir(), "deck-client-state-"));
  return { env: { ...process.env, DECK_CLIENT_STATE_DIRECTORY: directory }, close: () => rm(directory, { recursive: true, force: true }) };
}
