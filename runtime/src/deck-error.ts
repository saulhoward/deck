import type { KnownCommandErrorCode } from "./generated/contracts.js";

export class DeckError extends Error {
  constructor(public readonly code: KnownCommandErrorCode, message: string) { super(message); }
}
