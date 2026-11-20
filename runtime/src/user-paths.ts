import { isAbsolute, join } from "node:path";

// Match the native worker/launcher on both Linux and macOS. No legacy lookup.
function underHome(relative: string): string {
  const home = process.env.HOME;
  if (!home || !isAbsolute(home)) throw new Error("Deck requires an absolute HOME");
  return join(home, relative);
}
export const clientDirectory = () => process.env.DECK_CLIENT_STATE_DIRECTORY ?? underHome(".local/share/deck/client");
export const hubSecretReferences = () => underHome(".config/deck/hubs/default/.env");
