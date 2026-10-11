// Host-gate conformance probe (read-only, zero network).
//
// Offline smokes use a fake ctx, so they never exercise the two checks the real
// Host applies to every tool return value (dsh-tools lib/index.js:2577):
//   1. snapshotJsonValue(candidate) === undefined -> ToolOutputError
//      "tool \"x\" returned invalid output: value is not lossless JSON"
//   2. validateJsonSchemaValue(tool.output.schema, detached, "value") -> violations
// Missing that layer cost one real-Host failure: `sync_backup_run` returned
// `undefined` for absent optional fields, which is not a JSON value.
//
// This runs the plugin's ACTUAL tool definitions inside the REAL app-boot
// resolution + REAL ToolRuntime, calls each tool, and pushes the result through
// those same two gates. DSH_HOME points at a throwaway dir, so the plugin's
// startup run and scheduler cannot touch real state; nothing is written outside
// it and no request leaves the machine.
//
// app.asar is only importable from inside the Electron binary, so run it as Node:
//   $env:ELECTRON_RUN_AS_NODE=1
//   & "<install>\DeepSeek Harness.exe" --expose-internals <abs path to this file>
// Plain `node tools/host-gates.mjs` cannot read app.asar and will report a
// missing runtime.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(here, "..");
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), ".dsh", "profiles", "desktop");
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Programs", "DeepSeek Harness");
const RUNTIME = path.join(INSTALL_DIR, "resources", "app.asar", "dsh");

/** Locate a package directory inside the runtime, whichever nest it lives in. */
function runtimePkg(name) {
  const parts = name.split("/");
  const candidates = [
    path.join(RUNTIME, "node_modules", ...parts),
    path.join(RUNTIME, "..", "node_modules", ...parts),
  ];
  for (const dir of candidates) if (existsSync(path.join(dir, "package.json"))) return dir;
  throw new Error(`cannot locate ${name} under ${RUNTIME}`);
}

const DSH_PKG = runtimePkg("@deepseek-ai/dsh");
const ANCHOR = path.join(DSH_PKG, "package.json");
if (!existsSync(path.join(PROFILE_DIR, "package.json"))) {
  console.error(`profile not found: ${PROFILE_DIR}\nSet DSH_PROFILE_DIR to your profile directory.`);
  process.exit(2);
}
const url = (p) => pathToFileURL(p).href;
const pick = (m) => (typeof m === "function" || typeof m?.apply === "function" ? m : m.default);
const load = (dir) => import(url(path.join(dir, "lib", "index.js")));

// Throwaway home: never let the probe touch the real ~/.dsh.
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-sync-backup-gates-"));
await fs.writeFile(path.join(tmpHome, "AGENTS.md"), "# gate probe\n", "utf8");
await fs.writeFile(path.join(tmpHome, "dsh-auto-memory.json"), "{}\n", "utf8");
process.env.DSH_HOME = tmpHome;
console.log("[0] DSH_HOME          =", tmpHome, "(throwaway)");
console.log("    runtime           =", RUNTIME);

const boot = await load(runtimePkg("@deepseek-ai/dsh-app-boot"));
const profile = boot.loadProfileDirectory("dsh", PROFILE_DIR, ANCHOR);
const resolution = await boot.createRuntimeResolution({ installAnchor: ANCHOR, profile });
const all = boot.composeEntries([...profile.layers.map((l) => l.patches), profile.patches], () => {});
const row = all.find((e) => e.id === "sync-backup");
if (row === undefined) {
  console.error("sync-backup row not found in the composed profile");
  process.exit(2);
}
console.log("[1] row               =", row.name);

const cordis = await load(runtimePkg("@deepseek-ai/cordis"));
const Context = cordis.Context ?? cordis.default?.Context;
const ctx = new Context();
ctx.baseUrl = url(`${PROFILE_DIR}/`);
new boot.PluginPackages(ctx, { resolution });
// ToolRuntime injects systemPrompt; without it `tools` stays pending and every
// tool depending on it silently never mounts.
ctx.provide("systemPrompt", { section: () => () => {}, tools: () => () => {}, getSectionOrder: () => 0 });

const toolsDir = runtimePkg("@deepseek-ai/dsh-tools");
const toolsUrl = url(path.join(toolsDir, "lib", "index.js"));
await ctx.plugin(pick(await import(toolsUrl)), { mode: "native" });

// 真实宿主里 `credentials` 由 base bundle 提供，且**早于**插件就绪。这里照实装配它，
// 否则本探针测的是「服务缺失」那条路径（表现为 run 卡在等待里），而不是真实运行形态。
// 2026-10-11 教训：v4 的启动竞态正因为探针没装配该服务而长期没被发现。
const credRow = all.find((e) => e.id === "credentials");
if (credRow) {
  const credMod = pick(await import(url(path.join(runtimePkg(credRow.name), "lib", "index.js"))));
  await ctx.plugin(credMod, credMod.Config ? credMod.Config(credRow.config ?? {}) : (credRow.config ?? {}));
  await new Promise((r) => setTimeout(r, 800));
  console.log("[1b] credentials       =", typeof ctx.get("credentials"));
} else {
  console.log("[1b] credentials       = (profile 里没有该行，将走 fail-closed 路径)");
}

const plugin = pick(await import(url(path.join(PLUGIN_DIR, "index.js"))));
await ctx.plugin(plugin, plugin.Config(row.config));
await new Promise((r) => setTimeout(r, 1500));

const { validateJsonSchemaValue } = await import(toolsUrl);
const { snapshotJsonValue } = await import(url(path.join(runtimePkg("@deepseek-ai/dsh-util-values"), "lib", "index.js")));
console.log("[2] gates available   =", typeof snapshotJsonValue === "function" && typeof validateJsonSchemaValue === "function");

/** Exactly projectValue's two checks; returns failure strings. */
function hostGates(candidate, schema) {
  const detached = snapshotJsonValue(candidate);
  if (detached === undefined) return ["TOOL_OUTPUT_ERROR value is not lossless JSON"];
  return validateJsonSchemaValue(schema, detached, "value");
}

/** The Host only says "not lossless"; name the offending path for a fix. */
function findUndefined(v, p = "") {
  if (v === undefined) return [p || "(root)"];
  if (v === null || typeof v !== "object") return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => findUndefined(x, `${p}[${i}]`));
  return Object.keys(v).flatMap((k) => findUndefined(v[k], p ? `${p}.${k}` : k));
}

const t = ctx.get("tools");
const defs = [];
for (const [, d] of t.view().visible) if (String(d?.name).startsWith("sync_backup")) defs.push(d);
console.log("[3] tools found       =", defs.map((d) => d.name).join(", "));

let failures = 0;
for (const name of ["sync_backup_status", "sync_backup_run"]) {
  const d = defs.find((x) => x.name === name);
  if (d === undefined) { console.log(`\n!! ${name} NOT FOUND`); failures++; continue; }
  let value;
  try {
    value = await d.execute({}, {});
  } catch (error) {
    console.log(`\n[${name}] execute THREW: ${error.name} | ${String(error.message).split("\n")[0]}`);
    failures++;
    continue;
  }
  const undef = findUndefined(value);
  const problems = hostGates(value, d.output.schema);
  console.log(`\n[${name}]`);
  console.log(`  keys      = ${Object.keys(value).join(", ")}`);
  console.log(`  undefined = ${undef.length === 0 ? "(none)" : undef.join(", ")}`);
  if (problems.length === 0) {
    console.log("  HOST GATES = PASS");
  } else {
    console.log("  HOST GATES = FAIL");
    for (const p of problems) console.log(`    - ${p}`);
    failures++;
  }
  if (name === "sync_backup_run") {
    const rendered = d.output.render({}, value)?.[0]?.text ?? "";
    console.log(`  render    = ${rendered.split("\n").join(" | ")}`);
  }
}

await ctx.fiber.dispose();
await fs.rm(tmpHome, { recursive: true, force: true });
console.log(`\nRESULT: ${failures === 0 ? "ALL TOOL OUTPUTS PASS THE REAL HOST GATES" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
