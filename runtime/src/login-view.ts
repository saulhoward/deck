import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { validLoginEvent, validLoginPrompt, type LoginEvent, type LoginPrompt } from "./generated/contracts.js";
import { validLoginSnapshot } from "./status-login-contracts.js";

// Provider data is not a Deck wire record. Copy only public interaction fields;
// never spread provider objects, credentials or arbitrary extensions into IPC.
export function projectLoginEvent(event: AuthEvent): LoginEvent {
  let view: unknown;
  switch (event.type) {
    case "info": view = { type: event.type, message: event.message, ...(event.links === undefined ? {} : { links: event.links.map((link) => ({ url: link.url, ...(link.label === undefined ? {} : { label: link.label }) })) }) }; break;
    case "auth_url": view = { type: event.type, url: event.url, ...(event.instructions === undefined ? {} : { instructions: event.instructions }) }; break;
    case "device_code": view = { type: event.type, userCode: event.userCode, verificationUri: event.verificationUri, ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }), ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }) }; break;
    case "progress": view = { type: event.type, message: event.message }; break;
  }
  if (!validLoginEvent(view)) throw new Error("Invalid provider login event");
  return view;
}
export function projectLoginPrompt(id: string, prompt: AuthPrompt): LoginPrompt {
  const view = { id, type: prompt.type, message: prompt.message, ...(prompt.type === "select" ? { options: prompt.options.map((option) => ({ id: option.id, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })) } : {}) };
  if (!validLoginPrompt(view) || !validLoginSnapshot({ status: "pending", id: "projection", events: [], prompt: view })) throw new Error("Invalid provider login prompt");
  return view;
}
