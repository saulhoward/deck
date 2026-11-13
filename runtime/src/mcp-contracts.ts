// Deck's deliberately bounded MCP subset, not a permissive JSON Schema engine.
import { parseMcpJson } from "./mcp-json.js";
import { createHash } from "node:crypto";
import { validMcpCatalog, validMcpCallPlan, type McpCatalog, type McpCallPlan, type McpTool } from "./generated/contracts.js";
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === "object" && !Array.isArray(v);
const size = (v: string, limit: number) => v.isWellFormed() && Buffer.byteLength(v) <= limit;
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
const count = (v: unknown, max: number): v is number => number(v) && Number.isInteger(v) && v >= 0 && v <= max;
const key = (v: string) => !!v && size(v, 64) && !["__proto__", "constructor", "prototype"].includes(v);
export function schemaSupported(value: unknown): value is ObjectValue {
  let nodes = 0;
  const visit = (s: unknown, depth: number): boolean => {
    if (!object(s) || depth > 8 || ++nodes > 256 || typeof s.type !== "string") return false;
    const common = ["type", "description", "title", "enum"];
    const allowed: Record<string, string[]> = { object: ["properties", "required", "additionalProperties"], array: ["items", "minItems", "maxItems"], string: ["minLength", "maxLength"], number: ["minimum", "maximum"], integer: ["minimum", "maximum"], boolean: [], null: [] };
    if (!Object.hasOwn(allowed, s.type) || Object.keys(s).some(k => !common.includes(k) && !allowed[s.type as string]!.includes(k))) return false;
    for (const k of ["description", "title"]) if (s[k] !== undefined && (typeof s[k] !== "string" || !size(s[k] as string, 2048))) return false;
    if (s.enum !== undefined) {
      if (["object", "array"].includes(s.type) || !Array.isArray(s.enum) || !s.enum.length || s.enum.length > 32) return false;
      if (s.enum.some((v, i, all) => !valueMatches({ ...s, enum: undefined }, v) || all.slice(0, i).some(p => p === v))) return false;
    }
    if (s.type === "object") {
      if (s.additionalProperties !== false || !object(s.properties) || Object.keys(s.properties).length > 32 || !Array.isArray(s.required) || s.required.length > 32) return false;
      if (s.required.some((k, i, all) => typeof k !== "string" || !Object.hasOwn(s.properties as object, k) || all.indexOf(k) !== i)) return false;
      return Object.entries(s.properties).every(([k, v]) => key(k) && visit(v, depth + 1));
    }
    if (s.type === "array") return count(s.maxItems, 64) && (s.minItems === undefined || count(s.minItems, s.maxItems)) && visit(s.items, depth + 1);
    if (s.type === "string") return (s.maxLength === undefined || count(s.maxLength, 32768)) && (s.minLength === undefined || count(s.minLength, (s.maxLength as number | undefined) ?? 32768));
    if (["number", "integer"].includes(s.type)) return ["minimum", "maximum"].every(k => s[k] === undefined || number(s[k])) && (s.minimum === undefined || s.maximum === undefined || (s.minimum as number) <= (s.maximum as number));
    return true;
  };
  return visit(value, 0);
}
// Call only after validating the schema; nested values are bounded by the wire byte limit.
export function valueMatches(s: ObjectValue, v: unknown): boolean {
  if (Array.isArray(s.enum) && !s.enum.includes(v)) return false;
  switch (s.type) {
    case "object": return object(v) && (s.required as string[]).every(k => Object.hasOwn(v, k)) && Object.entries(v).every(([k, value]) => Object.hasOwn(s.properties as object, k) && valueMatches((s.properties as Record<string, ObjectValue>)[k]!, value));
    case "array": return Array.isArray(v) && v.length >= ((s.minItems as number) ?? 0) && v.length <= (s.maxItems as number) && v.every(item => valueMatches(s.items as ObjectValue, item));
    case "string": return typeof v === "string" && v.isWellFormed() && [...v].length >= ((s.minLength as number) ?? 0) && [...v].length <= ((s.maxLength as number) ?? 32768);
    case "number": case "integer": return number(v) && (s.type !== "integer" || Number.isInteger(v)) && v >= ((s.minimum as number) ?? -Number.MAX_SAFE_INTEGER) && v <= ((s.maximum as number) ?? Number.MAX_SAFE_INTEGER);
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    default: return false;
  }
}
export function parseSchema(text: string): ObjectValue {
  if (!size(text, 16384)) throw new Error("Invalid MCP schema");
  const value: unknown = parseMcpJson(text);
  if (!schemaSupported(value) || value.type !== "object") throw new Error("Unsupported MCP schema");
  return value;
}
export const schemaHash = (tool: McpTool) => createHash("sha256").update(tool.inputSchema + "\n" + (tool.outputSchema ?? "")).digest("hex");
export function validCatalog(v: unknown): v is McpCatalog {
  if (!validMcpCatalog(v)) return false;
  const keys = new Set<string>();
  try { for (const p of v.profiles) {
    const id = `${p.machineId}/${p.id}`; if (keys.has(id)) return false; keys.add(id);
    const names = new Set<string>();
    for (const t of p.tools) { if (names.has(t.name) || !size(t.description, 2048)) return false; names.add(t.name); parseSchema(t.inputSchema); if (t.outputSchema !== undefined) parseSchema(t.outputSchema); }
  } } catch { return false; }
  return Buffer.byteLength(JSON.stringify(v)) <= 256 * 1024;
}
export function validCallPlan(v: unknown): v is McpCallPlan {
  if (!validMcpCallPlan(v) || !Number.isSafeInteger(Number(v.conversationId)) || !size(v.argumentsJSON, 32768) || /[\r\n]/.test(v.argumentsJSON)) return false;
  try { const args: unknown = parseMcpJson(v.argumentsJSON); return object(args) && boundedJson(args); } catch { return false; }
}
export function boundedJson(v: unknown): boolean {
  let nodes = 0;
  const walk = (x: unknown, depth: number): boolean => {
    if (++nodes > 8192 || depth > 32) return false;
    if (x === null || typeof x === "boolean") return true;
    if (typeof x === "number") return number(x);
    if (typeof x === "string") return size(x,65536);
    if (Array.isArray(x)) return x.every(item => walk(item, depth + 1));
    return object(x) && Object.entries(x).every(([k, value]) => k.isWellFormed() && walk(value, depth + 1));
  };
  return walk(v, 0);
}
export function validToolResult(v: unknown, tool?: McpTool): boolean {
  if (!boundedJson(v) || !object(v) || Object.keys(v).some(k => !["content", "structuredContent", "isError", "_meta"].includes(k)) || !Array.isArray(v.content) || v.content.length > 64 || (v.isError !== undefined && typeof v.isError !== "boolean") || (v._meta !== undefined && !object(v._meta))) return false;
  if (!v.content.every(p => object(p) && Object.keys(p).every(k => k === "type" || k === "text") && p.type === "text" && typeof p.text === "string" && size(p.text, 65536))) return false;
  if (v.structuredContent !== undefined && !object(v.structuredContent)) return false;
  if (tool?.outputSchema && !v.isError && !valueMatches(parseSchema(tool.outputSchema), v.structuredContent)) return false;
  return true; // The enclosing original JSON-RPC bytes carry the aggregate size bound.
}
export function validRpcReply(text: string, id: string, tool?: McpTool): boolean {
  if (!size(text, 65536)) return false;
  try {
    const v: unknown = parseMcpJson(text);
    if (!boundedJson(v) || !object(v) || v.jsonrpc !== "2.0" || v.id !== `call:${id}` || Object.keys(v).some(k => !["jsonrpc", "id", "result", "error"].includes(k)) || (Object.hasOwn(v, "result") === Object.hasOwn(v, "error"))) return false;
    if (Object.hasOwn(v, "result")) return validToolResult(v.result, tool);
    return object(v.error) && Object.keys(v.error).every(k => ["code", "message", "data"].includes(k)) && number(v.error.code) && Number.isInteger(v.error.code) && typeof v.error.message === "string";
  } catch { return false; }
}
