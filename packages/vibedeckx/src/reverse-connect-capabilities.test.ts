import { describe, it, expect } from "vitest";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_CAPABILITIES } from "./reverse-connect-capabilities.js";

/**
 * Reconciliation between the capability registry and the actual tunnel call
 * sites (docs/server-worker-compat-design.md §3.1). Fails when:
 *  - a call site tunnels a method+path that is not registered (add the entry,
 *    and make the calling code tolerate old workers 404ing it), or
 *  - a registry entry no longer has any call site (stale — either remove it
 *    via the deprecation flow or fix the extraction below), or
 *  - a call site's path can't be statically resolved and its file is not
 *    covered by HARVEST_FUNCTIONS / PASSTHROUGH_FILES, or
 *  - a wrapper around proxyToRemoteAuto exists under a name missing from
 *    HTTP_SENDER_NAMES (a renamed alias can't silently escape extraction).
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

const ROOT_HTTP_SENDER = "proxyToRemoteAuto";
const RAW_SENDER_NAME = "sendRawHttpRequest";
const WS_SENDER_NAME = "openVirtualChannel";
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/**
 * The maintained sender-name list: proxyToRemoteAuto plus every wrapper name
 * bound to it. The "wrapper list is sound and complete" test enforces this in
 * both directions against the source, so the list can neither rot nor be
 * bypassed by a new alias.
 */
const HTTP_SENDER_NAMES = new Set([ROOT_HTTP_SENDER, "proxyAuto", "proxy"]);

// Files whose sender calls pass a runtime-computed path built from a closed
// set elsewhere in the same file: harvest the real path literals out of the
// named function instead of trusting a hand-written list, so editing that
// function without updating the registry fails this test.
const HARVEST_FUNCTIONS: Record<string, { fn: string; method: string }> = {
  "routes/cross-remote-mcp-routes.ts": { fn: "buildTargetCall", method: "POST" },
};

// Files allowed to send caller-supplied paths (unbounded by design), covered
// by a passthrough registry entry instead of per-route ones.
const PASSTHROUGH_FILES: Record<string, string> = {
  "routes/browser-proxy-routes.ts": "passthrough:browser-proxy",
};

// Skip: the tunnel plumbing itself (its inner sends are the transport, not
// call sites of the worker API contract).
const SKIP_FILES = new Set(["utils/remote-proxy.ts", "reverse-connect-manager.ts"]);

interface CallSite {
  file: string;
  line: number;
  key: string; // "http:<METHOD> <path>" | "ws:<path>" | "dynamic"
}

/** Mirrors the normalization documented in reverse-connect-capabilities.ts. */
function normalizeTunnelPath(raw: string): string {
  let p = raw;
  const q = p.indexOf("?");
  if (q !== -1) p = p.slice(0, q);
  // A template expression appended straight after a path segment (no "/")
  // carries a query string variable, not a path segment.
  if (p.endsWith(":param") && !p.endsWith("/:param")) p = p.slice(0, -":param".length);
  return p;
}

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) out += `:param${span.literal.text}`;
    return out;
  }
  return undefined;
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$|\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

function parseAll(): Map<string, ts.SourceFile> {
  const sources = new Map<string, ts.SourceFile>();
  for (const file of listSourceFiles(SRC_DIR)) {
    const rel = path.relative(SRC_DIR, file);
    if (SKIP_FILES.has(rel)) continue;
    sources.set(rel, ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true));
  }
  return sources;
}

/**
 * A binding is wrapper-shaped over `senders` when its initializer is a bare
 * alias (`= proxyToRemoteAuto`), a fallback chain with a sender arm
 * (`deps.proxy ?? proxyToRemoteAuto`), or a function expression whose body
 * calls a sender FORWARDING ≥2 of the function's own parameters
 * (`(m, p) => proxyToRemoteAuto(id, m, p, ...)`). The parameter-forwarding
 * requirement separates real wrappers from plugin/handler closures that merely
 * contain sender calls with their own literals.
 */
function functionForwardsToSender(
  fn: { parameters: ts.NodeArray<ts.ParameterDeclaration>; body?: ts.Node },
  senders: Set<string>,
): boolean {
  if (!fn.body) return false;
  const paramNames = new Set(
    fn.parameters
      .map((p) => (ts.isIdentifier(p.name) ? p.name.text : undefined))
      .filter((n): n is string => n !== undefined)
  );
  let forwards = false;
  const walk = (inner: ts.Node) => {
    if (forwards) return;
    if (ts.isCallExpression(inner)) {
      const name = calleeName(inner.expression);
      if (name !== undefined && senders.has(name)) {
        const forwardedParams = inner.arguments.filter(
          (a) => ts.isIdentifier(a) && paramNames.has(a.text)
        ).length;
        if (forwardedParams >= 2) {
          forwards = true;
          return;
        }
      }
    }
    ts.forEachChild(inner, walk);
  };
  walk(fn.body);
  return forwards;
}

function isWrapperShape(node: ts.Expression, senders: Set<string>): boolean {
  if (ts.isIdentifier(node)) return senders.has(node.text);
  if (ts.isParenthesizedExpression(node)) return isWrapperShape(node.expression, senders);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      return isWrapperShape(node.left, senders) || isWrapperShape(node.right, senders);
    }
    return false;
  }
  if (ts.isConditionalExpression(node)) {
    return isWrapperShape(node.whenTrue, senders) || isWrapperShape(node.whenFalse, senders);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return functionForwardsToSender(node, senders);
  }
  return false;
}

/** Every wrapper-shaped binding in the codebase: name → declaration sites. */
function findWrapperBindings(sources: Map<string, ts.SourceFile>): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  for (const [rel, source] of sources) {
    const visit = (node: ts.Node) => {
      let name: string | undefined;
      let initializer: ts.Node | undefined;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        name = node.name.text;
        initializer = node.initializer;
      } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
        name = node.name.text;
        initializer = node.initializer;
      } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
        name = node.name.text;
        initializer = node.initializer;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left)
      ) {
        name = node.left.name.text;
        initializer = node.right;
      }

      let isWrapper =
        name !== undefined && initializer !== undefined &&
        ts.isExpression(initializer) && isWrapperShape(initializer, HTTP_SENDER_NAMES);

      // `function proxyAuto(...) { return proxyToRemoteAuto(...) }` — the
      // form actually used in several routes files.
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined && ts.isIdentifier(node.name)) {
        if (functionForwardsToSender(node, HTTP_SENDER_NAMES)) {
          name = node.name.text;
          isWrapper = true;
        }
      }
      // `import { proxyToRemoteAuto as sendToWorker }` — a rename at the
      // import boundary is a wrapper binding too.
      if (ts.isImportSpecifier(node) && node.propertyName !== undefined && HTTP_SENDER_NAMES.has(node.propertyName.text)) {
        name = node.name.text;
        isWrapper = true;
      }

      if (isWrapper && name !== undefined) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const existing = bindings.get(name) ?? [];
        existing.push(`${rel}:${line}`);
        bindings.set(name, existing);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return bindings;
}

function extractCallSites(sources: Map<string, ts.SourceFile>): CallSite[] {
  const sites: CallSite[] = [];
  for (const [rel, source] of sources) {
    // String constants in this file (e.g. `const OUTBOX_QUERY_PATH = "..."`,
    // `const wsPath = \`...\``) so identifier path args resolve. A name bound
    // to several literals keeps all candidates.
    const constants = new Map<string, string[]>();
    const collectConstants = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const text = literalText(node.initializer);
        if (text !== undefined) {
          const existing = constants.get(node.name.text) ?? [];
          existing.push(text);
          constants.set(node.name.text, existing);
        }
      }
      ts.forEachChild(node, collectConstants);
    };
    collectConstants(source);

    const resolvePathArg = (arg: ts.Expression): string[] | undefined => {
      const direct = literalText(arg);
      if (direct !== undefined) return [direct];
      if (ts.isIdentifier(arg)) return constants.get(arg.text);
      return undefined;
    };

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

        if (name !== undefined && HTTP_SENDER_NAMES.has(name) && node.arguments.length >= 3) {
          const methodArg = node.arguments[1]!;
          const pathArg = node.arguments[2]!;
          const method = literalText(methodArg);
          if (method !== undefined && HTTP_METHODS.has(method)) {
            const paths = resolvePathArg(pathArg);
            if (paths === undefined) {
              sites.push({ file: rel, line, key: "dynamic" });
            } else {
              for (const p of paths) {
                sites.push({ file: rel, line, key: `http:${method} ${normalizeTunnelPath(p)}` });
              }
            }
          } else if (method === undefined && !ts.isIdentifier(methodArg)) {
            sites.push({ file: rel, line, key: "dynamic" });
          }
          // method as bare identifier = a wrapper definition forwarding its
          // own params; the wrapper's real call sites are extracted where the
          // literals appear (wrapper names themselves are in HTTP_SENDER_NAMES).
        }

        if (name === RAW_SENDER_NAME) {
          sites.push({ file: rel, line, key: "dynamic" });
        }

        if (name === WS_SENDER_NAME && node.arguments.length >= 3) {
          const paths = resolvePathArg(node.arguments[2]!);
          if (paths === undefined) {
            sites.push({ file: rel, line, key: "dynamic" });
          } else {
            for (const p of paths) {
              sites.push({ file: rel, line, key: `ws:${normalizeTunnelPath(p)}` });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

/** Path literals assigned to `path:` inside the named function — the closed set a dynamic call site draws from. */
function harvestPathLiterals(source: ts.SourceFile, fnName: string): string[] {
  let fnNode: ts.Node | undefined;
  const find = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) fnNode = node;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === fnName) fnNode = node;
    if (!fnNode) ts.forEachChild(node, find);
  };
  find(source);
  if (!fnNode) throw new Error(`HARVEST_FUNCTIONS: function ${fnName} not found — update the config`);

  const paths: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "path") {
      const text = literalText(node.initializer);
      if (text !== undefined) paths.push(text);
    }
    ts.forEachChild(node, walk);
  };
  walk(fnNode);
  if (paths.length === 0) throw new Error(`HARVEST_FUNCTIONS: no path literals found in ${fnName}`);
  return paths;
}

describe("reverse-connect capability registry", () => {
  const sources = parseAll();
  const sites = extractCallSites(sources);
  const staticSites = sites.filter((s) => s.key !== "dynamic");
  const dynamicSites = sites.filter((s) => s.key === "dynamic");

  // Real path literals behind the allowlisted dynamic call sites.
  const harvestedKeys = new Map<string, string[]>();
  for (const [file, { fn, method }] of Object.entries(HARVEST_FUNCTIONS)) {
    const source = sources.get(file);
    if (!source) throw new Error(`HARVEST_FUNCTIONS: file ${file} not found`);
    harvestedKeys.set(file, harvestPathLiterals(source, fn).map((p) => `http:${method} ${normalizeTunnelPath(p)}`));
  }

  it("wrapper list is sound and complete", () => {
    const bindings = findWrapperBindings(sources);
    // Complete: every wrapper-shaped binding is a listed sender name, so call
    // sites migrated to a new alias cannot escape extraction.
    const unlisted = [...bindings.entries()].filter(([name]) => !HTTP_SENDER_NAMES.has(name));
    expect(
      unlisted,
      `Bindings that forward to proxyToRemoteAuto but are missing from HTTP_SENDER_NAMES:\n${unlisted.map(([n, sites_]) => `${n}: ${sites_.join(", ")}`).join("\n")}`
    ).toEqual([]);
    // Sound: every listed wrapper name still has a forwarding binding.
    const rotted = [...HTTP_SENDER_NAMES].filter((n) => n !== ROOT_HTTP_SENDER && !bindings.has(n));
    expect(rotted, `HTTP_SENDER_NAMES entries with no forwarding binding left: ${rotted.join(", ")}`).toEqual([]);
  });

  it("extracts a plausible number of tunnel call sites (extraction self-check)", () => {
    // If a refactor breaks extraction wholesale, finding nothing must fail
    // loudly rather than vacuously pass the other tests.
    expect(staticSites.length).toBeGreaterThan(50);
  });

  it("every tunnel call site is registered", () => {
    const unregistered = staticSites.filter((s) => !(s.key in WORKER_CAPABILITIES));
    const message = unregistered
      .map((s) => `${s.file}:${s.line} → ${s.key}`)
      .join("\n");
    expect(unregistered, `Tunnel calls missing from reverse-connect-capabilities.ts (add an entry; the calling code must tolerate old workers 404ing it):\n${message}`).toEqual([]);
  });

  it("harvested dynamic paths are registered (buildTargetCall etc.)", () => {
    const missing: string[] = [];
    for (const [file, keys] of harvestedKeys) {
      for (const key of keys) {
        if (!(key in WORKER_CAPABILITIES)) missing.push(`${file} (${HARVEST_FUNCTIONS[file]!.fn}) → ${key}`);
      }
    }
    expect(missing, `Paths built by dynamic call sites but missing from the registry:\n${missing.join("\n")}`).toEqual([]);
  });

  it("dynamic-path call sites are explicitly allowlisted", () => {
    const unexpected = dynamicSites.filter(
      (s) => !(s.file in HARVEST_FUNCTIONS) && !(s.file in PASSTHROUGH_FILES)
    );
    const message = unexpected.map((s) => `${s.file}:${s.line}`).join("\n");
    expect(unexpected, `Tunnel calls with runtime-computed paths outside HARVEST_FUNCTIONS/PASSTHROUGH_FILES:\n${message}`).toEqual([]);
  });

  it("every registry entry has a live call site (no stale entries)", () => {
    const claimed = new Set<string>(staticSites.map((s) => s.key));
    for (const keys of harvestedKeys.values()) keys.forEach((k) => claimed.add(k));
    for (const key of Object.values(PASSTHROUGH_FILES)) claimed.add(key);
    const stale = Object.keys(WORKER_CAPABILITIES).filter((k) => !claimed.has(k));
    expect(stale, `Registry entries with no call site — remove via the deprecation flow, or fix extraction:\n${stale.join("\n")}`).toEqual([]);
  });

  it("registry snapshot (a diff here IS a tunnel-contract change — declare additive vs breaking in the PR)", () => {
    expect(Object.keys(WORKER_CAPABILITIES).sort()).toMatchSnapshot();
  });
});
