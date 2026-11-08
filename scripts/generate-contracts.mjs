import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Deliberately small compiler, not a general JSON Schema implementation. Unsupported
// keywords, references, regex constructs and type shapes fail generation, never pass
// unchecked into one language. Extend the subset only with parity fixtures/tests.
const dialect = "https://json-schema.org/draft/2020-12/schema";
const quote = JSON.stringify;
const zigQuote = (text) => '"' + [...Buffer.from(text)].map((byte) => byte === 34 || byte === 92 ? `\\${String.fromCharCode(byte)}` : byte >= 32 && byte < 127 ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, "0")}`).join("") + '"';
const identifier = /^[A-Za-z][A-Za-z0-9]*$/;
function insist(ok, message) { if (!ok) throw new Error(`Contract schema: ${message}`); }
function keys(value, allowed) {
  insist(value && typeof value === "object" && !Array.isArray(value), "expected schema object");
  for (const key of Object.keys(value)) insist(allowed.includes(key), `unsupported keyword ${key}`);
}

// Anchored ASCII concatenation: literals, positive character classes/ranges and
// bounded repetitions. Variable repetition must be last: no regex backtracking,
// Unicode/engine-dependent classes or ambiguous tokenization in either validator.
export function patternTokens(pattern) {
  const endAnchor = "$(?![\\s\\S])"; // Unlike $, cannot match before a final line terminator.
  insist(typeof pattern === "string" && pattern.startsWith("^") && pattern.endsWith(endAnchor), "pattern must use strict anchors");
  const source = pattern.slice(1, -endAnchor.length); const tokens = [];
  for (let i = 0; i < source.length;) {
    let chars = "";
    if (source[i] === "[") {
      const end = source.indexOf("]", ++i); insist(end > i, "invalid character class");
      const body = source.slice(i, end); i = end + 1;
      for (let j = 0; j < body.length; j++) {
        const first = body.charCodeAt(j);
        insist(first >= 32 && first < 127 && !"^\\[]".includes(body[j]), "unsupported character class");
        if (body[j + 1] === "-") {
          const last = body.charCodeAt(j + 2);
          insist(last >= first && last < 127, "invalid character range");
          for (let byte = first; byte <= last; byte++) chars += String.fromCharCode(byte);
          j += 2;
        } else chars += body[j];
      }
    } else {
      chars = source[i++];
      insist(chars.charCodeAt(0) >= 32 && chars.charCodeAt(0) < 127 && !".\\^$|?*+(){}]".includes(chars), "unsupported pattern construct");
    }
    let min = 1, max = 1;
    if (source[i] === "{") {
      const match = /^\{([0-9]+)(?:,([0-9]+))?\}/.exec(source.slice(i));
      insist(match, "invalid repetition"); i += match[0].length;
      min = Number(match[1]); max = Number(match[2] ?? match[1]);
      insist(Number.isSafeInteger(min) && min >= 0 && max >= min && max <= 4096, "unbounded repetition");
      insist(min === max || i === source.length, "variable repetition must be final");
    }
    tokens.push({ chars: [...new Set(chars)].join(""), min, max });
  }
  insist(tokens.length > 0, "empty pattern"); return tokens;
}

export function compileSchema(schema) {
  keys(schema, ["$schema", "$id", "$ref", "$defs"]);
  insist(schema.$schema === dialect && typeof schema.$id === "string", "unsupported dialect/identity");
  insist(schema.$defs && Object.keys(schema.$defs).length > 0, "missing definitions");
  const definitions = schema.$defs;
  for (const name of Object.keys(definitions)) insist(identifier.test(name), "invalid definition name");
  const target = (ref) => {
    insist(typeof ref === "string" && ref.startsWith("#/$defs/"), "only local definition references supported");
    const name = ref.slice(8); insist(Object.hasOwn(definitions, name), "unknown reference"); return name;
  };
  target(schema.$ref);
  const nodes = []; const seen = new Map(); const walking = new Set();
  const visit = (node) => {
    insist(!walking.has(node), "recursive references unsupported");
    if (seen.has(node)) return seen.get(node);
    keys(node, ["description", "$ref", "type", "const", "enum", "anyOf", "oneOf", "properties", "required", "additionalProperties", "minLength", "maxLength", "pattern", "minimum", "maximum"]);
    if (node.description !== undefined) insist(typeof node.description === "string", "invalid description");
    const shapeKeys = Object.keys(node).filter((key) => key !== "description");
    const id = nodes.length; nodes.push(node); seen.set(node, id); walking.add(node);
    if (node.$ref !== undefined) {
      insist(shapeKeys.length === 1, "reference siblings unsupported"); visit(definitions[target(node.$ref)]);
    } else if (node.anyOf !== undefined) {
      insist(shapeKeys.length === 1 && Array.isArray(node.anyOf) && node.anyOf.length === 2 && node.anyOf[1]?.type === "null", "only nullable anyOf supported");
      for (const child of node.anyOf) visit(child);
      insist(!nullable(node.anyOf[0]), "nested nullable unsupported");
    } else if (node.oneOf !== undefined) {
      insist(shapeKeys.length === 1 && Array.isArray(node.oneOf) && node.oneOf.length >= 2 && node.oneOf.length <= 8, "only bounded discriminated oneOf supported");
      for (const child of node.oneOf) visit(child);
      const branches = node.oneOf.map(resolve);
      insist(branches.every((branch) => branch.type === "object"), "oneOf variants must be objects");
      const discriminant = Object.keys(branches[0].properties).find((key) => {
        if (!branches.every((branch) => branch.required.includes(key) && Object.hasOwn(resolve(branch.properties[key]), "const"))) return false;
        return new Set(branches.map((branch) => quote(resolve(branch.properties[key]).const))).size === branches.length;
      });
      insist(discriminant !== undefined, "oneOf requires a common required property with distinct scalar constants");
    } else if (node.enum !== undefined) {
      insist(shapeKeys.length === 1 && Array.isArray(node.enum) && node.enum.length > 0 && new Set(node.enum).size === node.enum.length && node.enum.every((value) => typeof value === "string" && /^[a-z][a-z0-9_]*$/.test(value)), "only distinct identifier string enums supported");
    } else if (Object.hasOwn(node, "const")) {
      insist(shapeKeys.length === 1 && (typeof node.const === "string" || typeof node.const === "boolean" || Number.isSafeInteger(node.const)), "unsupported constant");
      if (typeof node.const === "string") insist(node.const.isWellFormed(), "invalid Unicode constant");
    } else if (node.type === "object") {
      insist(shapeKeys.every((key) => ["type", "properties", "required", "additionalProperties"].includes(key)), "unsupported object constraint");
      insist(node.properties && Array.isArray(node.required) && typeof node.additionalProperties === "boolean", "explicit object policy required");
      insist(new Set(node.required).size === node.required.length && node.required.every((key) => Object.hasOwn(node.properties, key)), "invalid required list");
      for (const [key, child] of Object.entries(node.properties)) { insist(identifier.test(key), "invalid property name"); visit(child); }
    } else if (node.type === "string") {
      insist(shapeKeys.every((key) => ["type", "minLength", "maxLength", "pattern"].includes(key)), "unsupported string constraint");
      for (const key of ["minLength", "maxLength"]) if (node[key] !== undefined) insist(Number.isSafeInteger(node[key]) && node[key] >= 0, "invalid string bound");
      insist((node.maxLength ?? Infinity) >= (node.minLength ?? 0), "inverted string bounds");
      if (node.pattern !== undefined) patternTokens(node.pattern);
    } else if (node.type === "integer") {
      insist(shapeKeys.every((key) => ["type", "minimum", "maximum"].includes(key)), "unsupported integer constraint");
      insist(Number.isSafeInteger(node.minimum) && Number.isSafeInteger(node.maximum) && node.minimum <= node.maximum, "explicit safe integer bounds required");
    } else if (node.type === "null" || node.type === "boolean") {
      insist(shapeKeys.length === 1, "unsupported primitive constraint");
    } else insist(shapeKeys.length === 0, "unsupported type/constraint");
    walking.delete(node); return id;
  };
  const resolve = (node) => node.$ref ? resolve(definitions[target(node.$ref)]) : node;
  const nullable = (node) => { const value = resolve(node); return value.type === "null" || value.anyOf !== undefined; };
  for (const node of Object.values(definitions)) visit(node);
  const fn = (node) => `v${seen.get(node)}`;
  const tsType = (node) => {
    if (node.$ref) return target(node.$ref);
    if (node.anyOf) return `${tsType(node.anyOf[0])} | null`;
    if (node.enum) return node.enum.map(quote).join(" | ");
    if (node.oneOf) return node.oneOf.map(tsType).join(" | ");
    if (Object.hasOwn(node, "const")) return quote(node.const);
    if (node.type === "object") return `{ ${[...Object.entries(node.properties).map(([key, child]) => `${key}${node.required.includes(key) ? "" : "?"}: ${tsType(child)}`), ...(node.additionalProperties ? ["[key: string]: unknown"] : [])].join("; ")} }`;
    return node.type === "integer" ? "number" : node.type ?? "unknown";
  };
  const zigType = (node) => {
    if (node.$ref) return target(node.$ref);
    if (node.anyOf) return `?${zigType(node.anyOf[0])}`;
    if (node.enum) return `enum { ${node.enum.map((value) => `@${zigQuote(value)}`).join(", ")} }`;
    if (node.oneOf) return `union(enum) {
${node.oneOf.map((child, index) => `    case${index}: ${zigType(child)},`).join("\n")}
    pub fn jsonParse(allocator: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) !@This() {
        return jsonParseFromValue(allocator, try std.json.innerParse(std.json.Value, allocator, source, options), options);
    }
    pub fn jsonParseFromValue(allocator: std.mem.Allocator, value: std.json.Value, options: std.json.ParseOptions) !@This() {
        var decode = options;
        decode.ignore_unknown_fields = true;
${node.oneOf.map((child, index) => `        if (${fn(child)}(value)) return .{ .case${index} = try std.json.innerParseFromValue(${zigType(child)}, allocator, value, decode) };`).join("\n")}
        return error.UnexpectedToken;
    }
    pub fn jsonStringify(self: @This(), writer: anytype) !void {
        switch (self) {
${node.oneOf.map((_child, index) => `            .case${index} => |value| try writer.write(value),`).join("\n")}
        }
    }
}`;
    if (Object.hasOwn(node, "const")) return typeof node.const === "string" ? "[]const u8" : typeof node.const === "boolean" ? "bool" : "i64";
    if (node.type === "object") return `struct {\n${Object.entries(node.properties).map(([key, child]) => {
      const type = zigType(child); const optional = !node.required.includes(key);
      return `    @${zigQuote(key)}: ${optional && !nullable(child) ? "?" : ""}${type}${optional ? " = null" : ""},`;
    }).join("\n")}\n}`;
    return ({ string: "[]const u8", integer: "i64", boolean: "bool", null: "@TypeOf(null)" })[node.type] ?? "std.json.Value";
  };
  const tsChecks = (node) => {
    if (node.$ref) return `${fn(definitions[target(node.$ref)])}(x)`;
    if (node.anyOf || node.oneOf) return (node.anyOf ?? node.oneOf).map((child) => `${fn(child)}(x)`).join(" || ");
    if (node.enum) return node.enum.map((value) => `x === ${quote(value)}`).join(" || ");
    if (Object.hasOwn(node, "const")) return `x === ${quote(node.const)}`;
    if (node.type === "string") return [`string(x, ${node.minLength ?? 0}, ${node.maxLength ?? "Infinity"})`, ...(node.pattern === undefined ? [] : [`(new RegExp(${quote(node.pattern)}).exec(x)?.[0] === x)`])].join(" && ");
    if (node.type === "integer") return `typeof x === "number" && Number.isSafeInteger(x) && x >= ${node.minimum} && x <= ${node.maximum}`;
    if (node.type === "null") return "x === null";
    if (node.type === "boolean") return 'typeof x === "boolean"';
    if (node.type === "object") return ["object(x)", ...Object.entries(node.properties).map(([key, child]) => node.required.includes(key) ? `(Object.hasOwn(x, ${quote(key)}) && ${fn(child)}(x.${key}))` : `(!Object.hasOwn(x, ${quote(key)}) || ${fn(child)}(x.${key}))`), ...(node.additionalProperties ? [] : [`Object.keys(x).every((key) => ${quote(Object.keys(node.properties))}.includes(key))`])].join(" && ");
    return "true";
  };
  const zigBody = (node) => {
    if (node.$ref) return `return ${fn(definitions[target(node.$ref)])}(x);`;
    if (node.anyOf || node.oneOf) return `return ${(node.anyOf ?? node.oneOf).map((child) => `${fn(child)}(x)`).join(" or ")};`;
    if (node.enum) return `return x == .string and (${node.enum.map((value) => `std.mem.eql(u8, x.string, ${zigQuote(value)})`).join(" or ")});`;
    if (Object.hasOwn(node, "const")) return typeof node.const === "string" ? `return x == .string and std.mem.eql(u8, x.string, ${zigQuote(node.const)});` : typeof node.const === "boolean" ? `return x == .bool and x.bool == ${node.const};` : `return integer(x, ${node.const}, ${node.const});`;
    if (node.type === "string") return `if (x != .string) return false;\n    const length = std.unicode.utf8CountCodepoints(x.string) catch return false;\n    ${node.minLength === undefined && node.maxLength === undefined ? "_ = length;" : `if (${[...(node.minLength === undefined ? [] : [`length < ${node.minLength}`]), ...(node.maxLength === undefined ? [] : [`length > ${node.maxLength}`])].join(" or ")}) return false;`}\n    return ${node.pattern === undefined ? "true" : `pattern(x.string, &.{ ${patternTokens(node.pattern).map((token) => `.{ .chars = ${zigQuote(token.chars)}, .min = ${token.min}, .max = ${token.max} }`).join(", ")} })`};`;
    if (node.type === "integer") return `return integer(x, ${node.minimum}, ${node.maximum});`;
    if (node.type === "null") return "return x == .null;";
    if (node.type === "boolean") return "return x == .bool;";
    if (node.type === "object") return `if (x != .object) return false;\n    ${Object.entries(node.properties).map(([key, child]) => `if (x.object.get(${quote(key)})) |value| {\n        if (!${fn(child)}(value)) return false;\n    }${node.required.includes(key) ? " else return false;" : ""}`).join("\n    ")}\n    ${node.additionalProperties ? "" : Object.keys(node.properties).length === 0 ? "if (x.object.count() != 0) return false;\n    " : `for (x.object.keys()) |key| {\n        if (!(${Object.keys(node.properties).map((key) => `std.mem.eql(u8, key, ${quote(key)})`).join(" or ")})) return false;\n    }\n    `}return true;`;
    return "_ = x;\n    return true;";
  };
  const header = "// Generated by scripts/generate-contracts.mjs from contracts/wire.schema.json. DO NOT EDIT.\n";
  const ts = header + `function object(x: unknown): x is Record<string, unknown> { return x !== null && typeof x === "object" && !Array.isArray(x); }\nfunction string(x: unknown, min: number, max: number): x is string {\n  if (typeof x !== "string" || !x.isWellFormed()) return false;\n  if (min === 0 && max === Infinity) return true;\n  let length = 0;\n  for (const _ of x) { if (++length > max) return false; }\n  return length >= min;\n}\n` + Object.entries(definitions).map(([name, node]) => `export type ${name} = ${tsType(node)};\nexport const valid${name} = (x: unknown): x is ${name} => ${fn(node)}(x);\n`).join("") + nodes.map((node) => `function ${fn(node)}(x: unknown): boolean { return ${tsChecks(node)}; }\n`).join("");
  // Validate the entire tree before typed decode. The decoder must ignore
  // extensions globally: a closed root may contain an extensible nested object.
  // The generated guards, not this decoding option, enforce unknown-field policy.
  const zig = header + `const std = @import("std");\n
fn integer(x: std.json.Value, min: i64, max: i64) bool {
    return switch (x) {
        .integer => |n| n >= min and n <= max,
        .float => |n| std.math.isFinite(n) and @floor(n) == n and n >= @as(f64, @floatFromInt(min)) and n <= @as(f64, @floatFromInt(max)),
        else => false,
    };
}
const Token = struct { chars: []const u8, min: usize, max: usize };
fn pattern(value: []const u8, tokens: []const Token) bool {
    var offset: usize = 0;
    for (tokens) |token| {
        var count: usize = 0;
        while (offset < value.len and count < token.max and std.mem.indexOfScalar(u8, token.chars, value[offset]) != null) : (count += 1) { offset += 1; }
        if (count < token.min) return false;
    }
    return offset == value.len;
}
` + Object.entries(definitions).map(([name, node]) => `pub const ${name} = ${zigType(node)};\npub fn valid${name}(x: std.json.Value) bool { return ${fn(node)}(x); }\npub fn parse${name}(allocator: std.mem.Allocator, encoded: []const u8) !std.json.Parsed(${name}) {\n    const raw = try std.json.parseFromSlice(std.json.Value, allocator, encoded, .{});\n    defer raw.deinit();\n    if (!valid${name}(raw.value)) return error.InvalidContract;\n    return std.json.parseFromSlice(${name}, allocator, encoded, .{ .ignore_unknown_fields = true });\n}\n`).join("") + nodes.map((node) => `fn ${fn(node)}(x: std.json.Value) bool {\n    ${zigBody(node)}\n}\n`).join("");
  return { ts, zig };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const schema = JSON.parse(readFileSync(new URL("contracts/wire.schema.json", root), "utf8"));
  const outputs = compileSchema(schema);
  // Zig formatting is part of generation, using the project's pinned compiler.
  const { execFileSync } = await import("node:child_process");
  outputs.zig = execFileSync("zig", ["fmt", "--stdin"], { input: outputs.zig, encoding: "utf8" });
  const paths = { ts: "runtime/src/generated/contracts.ts", zig: "src/generated/contracts.zig" };
  for (const [language, path] of Object.entries(paths)) {
    const url = new URL(path, root);
    if (process.argv.includes("--check")) insist(readFileSync(url, "utf8") === outputs[language], `stale generated file ${path}; run npm run contracts:generate`);
    else writeFileSync(url, outputs[language]);
  }
}
