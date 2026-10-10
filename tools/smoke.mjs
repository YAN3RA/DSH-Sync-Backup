/**
 * dsh-sync-backup / tools/smoke.mjs
 *
 * Host 半冒烟测试：在**不启动 DSH** 的前提下，用一个假 ctx 驱动 index.js 的
 * apply()，验证：
 *  1. 模块可被 import（Config / apply / inject / name 四个导出齐全）；
 *  2. inject 与 name 与 cordis.patch.yml 的 `- id:` 一致（命名硬约束）；
 *  3. apply() 注册的两个工具名称、parameters、output.schema 形状正确；
 *  4. sync_backup_run 干跑成功，且**未产生任何网络请求**（fetch 被替换为抛错探针）；
 *  5. sync_backup_run upload=true 时被明确拒绝（P1 不出网）；
 *  6. state.json 被写入且内容正确（用临时 DSH_HOME，不碰真实 ~/.dsh）；
 *  7. 工具 render 输出可读（走一遍真实渲染路径）。
 *
 * 用法：node --import ./tools/_hooks-register.mjs tools/smoke.mjs
 *   （或直接用 npm 脚本的 --import 形式；见 README）
 */

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";

import * as plugin from "../index.js";

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? "  — " + detail : ""}`);
}

console.log("=== dsh-sync-backup Host-half smoke ===");

/* ---------- 0. 准备临时 DSH_HOME ---------- */
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-sync-backup-smoke-"));
process.env.DSH_HOME = tmpHome;
console.log(`临时 DSH_HOME = ${tmpHome}\n`);

// 造一点最小内容，让 collect 有东西可收
await fs.writeFile(path.join(tmpHome, "AGENTS.md"), "# test agents\n", "utf8");
await fs.writeFile(path.join(tmpHome, "dsh-auto-memory.json"), '{"a":1}\n', "utf8");
await fs.mkdir(path.join(tmpHome, "memory"), { recursive: true });
await fs.writeFile(path.join(tmpHome, "memory", "MEMORY.md"), "# memory\n", "utf8");
await fs.mkdir(path.join(tmpHome, "skills", "demo"), { recursive: true });
await fs.writeFile(path.join(tmpHome, "skills", "demo", "SKILL.md"), "# skill\n", "utf8");

/* ---------- 1. 导出形状 ---------- */
console.log("[1] 模块导出");
for (const k of ["Config", "apply", "inject", "name", "SECTION_TEXT"]) {
  check(k in plugin, `导出 ${k}`);
}
check(typeof plugin.apply === "function", "apply 是函数");
check(Array.isArray(plugin.inject), "inject 是数组", JSON.stringify(plugin.inject));
check(plugin.name === "sync-backup", "name === 'sync-backup'（须与 patch 的 - id: 一致）");

/* ---------- 2. patch 的 id 与 name 一致 ---------- */
console.log("\n[2] 命名硬约束（patch id ↔ export name）");
const patchPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "cordis.patch.yml");
let patchText = "";
try {
  patchText = await fs.readFile(patchPath, "utf8");
} catch {
  try {
    patchText = await fs.readFile(path.join(process.cwd(), "cordis.patch.yml"), "utf8");
  } catch {
    patchText = "";
  }
}
const idMatch = patchText.match(/^\s*-?\s*id:\s*([A-Za-z0-9_-]+)\s*$/m);
check(!!idMatch, "cordis.patch.yml 可读且含 id 行", idMatch ? idMatch[1] : "(未找到)");
check(idMatch && idMatch[1] === plugin.name, "patch 的 id 与 export name 一致", `${idMatch ? idMatch[1] : "?"} vs ${plugin.name}`);
check(/name:\s*'dsh-sync-backup'/.test(patchText), "patch 的 name 为 'dsh-sync-backup'");
check(/dryRun:\s*true/.test(patchText), "patch 中 dryRun: true（保护闸门保持）");
check(/webdavEnabled:\s*(true|false)/.test(patchText), "patch 含 webdavEnabled 开关");
check(/githubRepo:/.test(patchText), "patch 含 githubRepo 键");
check(/githubPath:/.test(patchText), "patch 含 githubPath 键");
check(/githubCredentialRef:/.test(patchText), "patch 含 githubCredentialRef 键");
check(/partialAlertAfter:/.test(patchText), "patch 含 partialAlertAfter 键");
check(/schedulerEnabled:\s*(true|false)/.test(patchText), "patch 含 schedulerEnabled 键");
check(/uploadOnSchedule:\s*(true|false)/.test(patchText), "patch 含 uploadOnSchedule 键");
check(/startupRunOnBoot:\s*(true|false)/.test(patchText), "patch 含 startupRunOnBoot 键");

/* ---------- 3. package.json 契约 ---------- */
console.log("\n[3] package.json 契约");
const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
check(pkg.name === "dsh-sync-backup", "name 正确");
check(pkg.type === "module", "type: module");
check(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch 存在（bundle 硬判据）");
// link: 安装时 DSH loader 只在插件自身声明了该 peer 时才拦截裸包解析
// （app-boot routeLinked -> readPeerNames），故 peerDependencies 必须存在。
const peers = pkg.peerDependencies ?? {};
check(peers["@deepseek-ai/dsh-tools"] !== undefined, "peerDependencies 声明 @deepseek-ai/dsh-tools（link 安装必需）");
check(peers["@deepseek-ai/schemastery"] !== undefined, "peerDependencies 声明 @deepseek-ai/schemastery（link 安装必需）");
check(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, "无 dependencies（不装任何包）");
check(pkg.exports?.["./lib/github.js"] === "./lib/github.js", "exports 暴露 ./lib/github.js");
check(pkg.exports?.["./lib/scheduler.js"] === "./lib/scheduler.js", "exports 暴露 ./lib/scheduler.js");
check(typeof pkg.scripts?.["github-smoke"] === "string", "scripts 含 github-smoke");
check(typeof pkg.scripts?.["scheduler-smoke"] === "string", "scripts 含 scheduler-smoke");
check(typeof pkg.scripts?.["scheduler-plan"] === "string", "scripts 含 scheduler-plan");
check(Array.isArray(pkg.keywords) && pkg.keywords.length > 0, "有 keywords（公开仓库元数据）");
check(Array.isArray(pkg.files) && pkg.files.includes("lib/"), "有 files 白名单（公开仓库元数据）");
// P5：client 半的 manifest 契约（细节由 client-smoke 全面覆盖，此处只锁串联与入口）。
check(pkg.exports?.["./client"] === "./lib/client.js", "exports 暴露 ./client（Web 半入口）");
check(pkg.dsh?.client?.platform === "web", "dsh.client.platform === 'web'");
check(typeof pkg.scripts?.["client-smoke"] === "string", "scripts 含 client-smoke");
// client-contract 是零依赖静态检查：浏览器产物没有类型检查、也没有 react-dom 可真渲，
// 「缺了某个 i18n 键」只会把键名原样渲染成占位串，只能靠静态扫源码发现。
check(typeof pkg.scripts?.["client-contract"] === "string", "scripts 含 client-contract（静态契约检查）");
// crypto-smoke 守的是「错了会静默」的那条线：恢复码解不出来、密钥换了但没报警，
// 都只会在半年后真要恢复的那一刻才暴露。
check(typeof pkg.scripts?.["crypto-smoke"] === "string", "scripts 含 crypto-smoke（加密/密钥/用户配置）");
// 两个凭据写入助手。报错串与 cordis.patch.yml 注释都引用了它们，
// 一旦改名会造成「照着文档做却找不到脚本」。
check(typeof pkg.scripts?.["set-webdav-password"] === "string", "scripts 含 set-webdav-password（凭据只写不读的入口）");
check(typeof pkg.scripts?.["set-github-token"] === "string", "scripts 含 set-github-token");
// host-gates 需要 Electron 才能读 app.asar，故**不进** test 串联（test 跑在纯 node 下）。
check(typeof pkg.scripts?.["host-gates"] === "string", "scripts 含 host-gates（真实 Host 双门校验，需 Electron）");
for (const s of ["smoke", "client-smoke", "client-contract", "crypto-smoke", "webdav-smoke", "github-smoke", "scheduler-smoke", "channels-smoke", "dry-run"]) {
  check(new RegExp(`npm run ${s}`).test(pkg.scripts?.test ?? ""), `test 串联 ${s}`);
}

/* ---------- 4. 假 ctx + apply ---------- */
console.log("\n[4] apply() 注册行为");
const registered = [];
const sections = [];
const effects = [];
const injectCalls = [];
const getCalls = [];
const logs = [];
const systemPromptStub = { section: (s) => { sections.push(s); return () => {}; } };
// RPC 通道探针：宿主在 connection+webServer 双就绪时回调 mountRpc，
// 这里捕获它注册的 (channel, dispatch)，以便直接驱动 dispatch 验证契约。
const rpcHandles = [];
const rpcWebEffects = [];
const webCtx = {
  connection: {
    rpc: {
      handle: (channel, dispatch) => { rpcHandles.push({ channel, dispatch }); return () => { rpcHandles.push({ disposed: channel }); }; },
    },
  },
  effect: (fn, label) => { rpcWebEffects.push(label); const d = fn(); return d; },
};
// 假 ctx 必须覆盖 apply() 真实触及的每个服务入口：
//   - ctx.get(name)   —— 官方口径的「可选服务」读法（systemPrompt 可能缺席）
//   - ctx.inject(...) —— 依赖 webServer 的 RPC 挂载点
//   - ctx.logger      —— BackupScheduler 的日志出口
// 早期版本只给了 tools/systemPrompt/effect，代码改用 ctx.get 后即判定失败（2026-10-09）。
const ctx = {
  tools: { register: (def) => registered.push(def) },
  systemPrompt: systemPromptStub,
  get: (name) => { getCalls.push(name); return name === "systemPrompt" ? systemPromptStub : undefined; },
  inject: (names, cb) => {
    injectCalls.push([...names]);
    // 真实宿主在这里回调一个「connection/webServer 均已就绪」的子上下文。
    // 同步回调是本测试的简化：真实 cordis 在依赖已满足时同样同步调用。
    if (names.includes("connection") && names.includes("webServer")) cb(webCtx);
    return () => {};
  },
  logger: {
    info: (...a) => logs.push(["info", ...a]),
    warn: (...a) => logs.push(["warn", ...a]),
    error: (...a) => logs.push(["error", ...a]),
  },
  effect: (fn, label) => { effects.push(label); const d = fn(); return d; },
};

let applied = false;
try {
  // 关掉定时器：本文件测的是工具面，定时器有独立单测（scheduler-smoke）。
  // 若开着，启动触发会并发跑一次 runOnce，与下面的状态断言竞态。
  plugin.apply(ctx, plugin.Config.resolve({ schedulerEnabled: false }));
  applied = true;
} catch (err) {
  check(false, "apply() 未抛错", err.message);
}
check(applied, "apply() 执行成功");
check(registered.length === 2, "注册了 2 个工具", registered.map((r) => r.name).join(", "));
check(registered.some((r) => r.name === "sync_backup_run"), "含 sync_backup_run");
check(registered.some((r) => r.name === "sync_backup_status"), "含 sync_backup_status");
check(sections.length === 1, "注册了 1 个提示词小节", sections[0]?.name);
check(effects.includes("sync-backup.section()"), "注册了提示词小节 effect");
check(!effects.includes("sync-backup.scheduler()"), "schedulerEnabled=false 时不注册定时器 effect");
// systemPrompt 是可选服务：必须走 ctx.get()，否则在缺该服务的宿主里整插件不激活。
check(getCalls.includes("systemPrompt"), "systemPrompt 经 ctx.get() 读取（可选服务口径）");
// RPC 挂载点：依赖 connection + webServer；宿主无此二服务时应静默跳过而不抛错。
check(injectCalls.some((n) => n.includes("connection") && n.includes("webServer")),
  "声明了 connection+webServer 的 RPC 挂载点", JSON.stringify(injectCalls));
for (const t of registered) {
  check(typeof t.description === "string" && t.description.length > 40, `${t.name} 描述充分`);
  // 真实 defineTool 已把 parameters 编译为顶层 object schema。
  // 断言「upload 是顶层属性」而**不是**「有 input 包装 」—— 后者是错误契约：
  // 写成 { input: {…} } 会让 execute 读不到 args.upload（2026-10-09 实测）。
  check(t.parameters?.type === "object", `${t.name} parameters 编译为顶层 object`);
  if (t.name === "sync_backup_run") {
    check(t.parameters?.properties?.upload?.type === "boolean", "sync_backup_run 的 upload 是顶层参数");
    check(t.parameters?.properties?.input === undefined, "sync_backup_run 没有多余的 input 包装层");
  } else {
    check(Object.keys(t.parameters?.properties ?? {}).length === 0, "sync_backup_status 无参数");
  }
  check(!!t.output?.schema, `${t.name} 有 output.schema`);
  check(typeof t.output?.render === "function", `${t.name} 有 render`);
}

/* ---------- 5. 网络探针 ---------- */
console.log("\n[5] 网络隔离探针（P1 绝不出网）");
let networkAttempts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  networkAttempts.push(String(url));
  throw new Error("smoke: 网络访问被探针拦截 — " + url);
};

const runTool = registered.find((r) => r.name === "sync_backup_run");

/* ---------- 6. dry-run 执行 ---------- */
console.log("\n[6] sync_backup_run（dry-run）");
const out = await runTool.execute({}, {});
check(out.ok === true, "dry-run 成功", out.error ?? "");
check(out.dryRun === true, "标记为 dry-run");
check(typeof out.fileCount === "number" && out.fileCount >= 4, "收集到文件", `${out.fileCount} 个`);
check(out.gzBytes > 0 && out.tarBytes > 0, "产出 tar 与 gzip 字节数", `tar ${out.tarBytes} / gz ${out.gzBytes}`);
check(networkAttempts.length === 0, "未发生任何网络请求", networkAttempts.join(", "));
check(out.partial === false, "dry-run 无半失败（partial=false）");
// ⚠️ 必须先断言「返回值里没有 undefined」：Host 用 snapshotJsonValue 校验工具返回值，
// 顶层出现 undefined 就抛 `value is not lossless JSON`，整个工具调用失败
// （源：dsh-tools lib/index.js:2577-2578）。假 ctx 不走这层校验，所以这条断言是
// 离线测试唯一能拦住该缺陷的地方 —— 曾因缺它而在真实 Host 上首次调用即失败。
{
  const undef = [];
  const walk = (v, p) => {
    if (v === undefined) { undef.push(p); return; }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
    for (const k of Object.keys(v)) walk(v[k], p ? `${p}.${k}` : k);
  };
  walk(out, "");
  check(undef.length === 0, "返回值无 undefined 字段（lossless JSON 契约）", undef.join(", "));
}
// 第二个门是 output.schema：声明了类型的键若**存在**就必须匹配，`null` 不是 object/string
// （dsh-tools lib/index.js:3543 validateJsonSchemaValue → checkValue:448-451）。
// 所以「无值」的唯一合法表达是键缺席 —— 既不能 undefined 也不能 null。
check(!("channels" in out), "dry-run 不产生通道结果（键缺席，既非 undefined 也非 null）");
check(!("remoteId" in out) && !("archiveUrl" in out), "dry-run 不含远端字段");
{
  // 迷你 schema 校验：只覆盖本工具声明过的类型，模拟 Host 的第二道门。
  const schema = runTool.output.schema ?? {};
  const props = schema.properties ?? {};
  const bad = [];
  for (const [k, spec] of Object.entries(props)) {
    if (!(k in out)) continue;
    const v = out[k];
    const t = spec.type;
    const okType =
      (t === "string" && typeof v === "string") ||
      (t === "number" && typeof v === "number") ||
      (t === "boolean" && typeof v === "boolean") ||
      (t === "object" && v !== null && typeof v === "object" && !Array.isArray(v));
    if (!okType) bad.push(`${k}=${JSON.stringify(v)} 期望 ${t}`);
  }
  check(bad.length === 0, "返回值符合 output.schema 声明的类型（第二道门）", bad.join("; "));
}
const rendered = runTool.output.render({}, out);
check(Array.isArray(rendered) && rendered[0]?.type === "text" && rendered[0].text.length > 10, "render 输出可读");
console.log("      render: " + rendered[0].text.split("\n").join(" | "));

/* ---------- 7. upload 被 dryRun 闸门拒绝 ---------- */
console.log("\n[7] sync_backup_run（upload=true，config.dryRun=true 时应被拒）");
const up = await runTool.execute({ upload: true }, {});
check(up.ok === false, "upload 被拒绝");
check(/dryRun/.test(up.error ?? ""), "错误信息指明 dryRun 闸门", up.error);
check(networkAttempts.length === 0, "仍无网络请求");

/* ---------- 7b. lib/creds.js 的 YAML 解析口径 ---------- */
console.log("\n[7b] lib/creds.js（凭据解析：只测纯函数，零网络）");
{
  const { readRefFromYaml, REF_PATTERN } = await import("../lib/creds.js");

  const v1 = [
    "version: 1",
    "records:",
    "  deepseek-account-platform/device:",
    "    kind: token",
    "refs:",
    "  DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD: hunter2",
    "  OTHER: x",
    "",
  ].join("\n");
  check(readRefFromYaml(v1, "DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD") === "hunter2", "v1 布局：从 refs 块取值");
  check(readRefFromYaml(v1, "MISSING") === undefined, "缺失 ref 返回 undefined");
  check(readRefFromYaml(v1, "kind") === undefined, "records 下的嵌套键不被当成 ref");

  const flat = "DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD: oldstyle\nOTHER: y\n";
  check(readRefFromYaml(flat, "DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD") === "oldstyle", "预发布扁平布局：顶层取值");

  // 同名时 refs 块为权威
  const both = [
    "DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD: flatvalue",
    "refs:",
    "  DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD: refsvalue",
    "",
  ].join("\n");
  check(readRefFromYaml(both, "DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD") === "refsvalue", "同名时 refs 块为权威");

  check(readRefFromYaml('refs:\n  K: "quoted"\n', "K") === "quoted", "剥除成对双引号");
  check(readRefFromYaml("refs:\n  K: ''\n", "K") === undefined, "空串视为未设置");
  check(readRefFromYaml("refs:\n  K:   \n", "K") === undefined, "纯空白视为未设置");
  check(readRefFromYaml("refs:\n  # K: commented\n", "K") === undefined, "注释行不当作键");
  check(readRefFromYaml("", "K") === undefined, "空文本返回 undefined");
  check(readRefFromYaml("refs:\n  K: v\n", "bad-name") === undefined, "非法 ref 名直接拒绝");
  check(REF_PATTERN.test("DSH_X") && !REF_PATTERN.test("1bad") && !REF_PATTERN.test("a-b"), "REF_PATTERN 与 DSH 服务同形");
}

/* ---------- 8. 状态文件 ---------- */
console.log("\n[8] 状态文件落盘");
const stateFile = path.join(tmpHome, "dsh-sync-backup", "state.json");
check(existsSync(stateFile), "state.json 已生成", stateFile);
const st = JSON.parse(await fs.readFile(stateFile, "utf8"));
check(st.pluginLoaded === true, "pluginLoaded: true");
check(typeof st.lastRunAt === "string", "记录 lastRunAt", st.lastRunAt);
check(st.runs === 2, "累计运行 2 次（dry-run + 被拒的 upload）", String(st.runs));
check(st.failures === 1, "连续失败 1 次", String(st.failures));

/* ---------- 9. status 工具 ---------- */
console.log("\n[9] sync_backup_status");
const statusTool = registered.find((r) => r.name === "sync_backup_status");
const stv = await statusTool.execute({}, {});
check(typeof stv.text === "string" && stv.text.includes("插件"), "status 输出可读");
check(/^WebDAV:/m.test(stv.text), "status 含 WebDAV 通道行");
check(/^GitHub:/m.test(stv.text), "status 含 GitHub 通道行");
// v3：GitHub 有了自己的总开关，默认关闭，于是默认文案是「未启用」而不是「未配置」。
// 断言跟到「这一行存在且表明通道未工作」这一层，不钉死具体措辞。
check(/GitHub: (未启用|未配置)/.test(stv.text), "GitHub 默认不工作（开关未开或仓库未配）");
console.log("      " + stv.text.split("\n").join("\n      "));

/* ---------- 10. 危险路径兜底 ---------- */
console.log("\n[10] 危险路径兜底（白名单外文件绝不进入归档）");
await fs.writeFile(path.join(tmpHome, ".credentials.yaml"), "version: 1\nrefs: {}\n", "utf8");
await fs.mkdir(path.join(tmpHome, "web-login"), { recursive: true });
await fs.writeFile(path.join(tmpHome, "web-login", "session.json"), "{}\n", "utf8");
const out2 = await runTool.execute({}, {});
check(out2.ok === true, "含危险文件时仍成功（它们本就不在白名单）");
check(out2.fileCount === out.fileCount, "文件数未因危险文件增加", `${out.fileCount} → ${out2.fileCount}`);

/* ---------- 11. 设置页 RPC 通道（P5） ---------- */
console.log("\n[11] 设置页 RPC 通道（P5）");
check(rpcHandles.length === 1, "注册了恰好 1 个 RPC 通道", JSON.stringify(rpcHandles.map((r) => r.channel ?? r.disposed)));
// 权威契约：CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/，必须带前导斜杠，且不得为保留的 "/api"。
check(rpcHandles[0]?.channel === "/sync-backup", "通道名为 /sync-backup（带前导斜杠）", String(rpcHandles[0]?.channel));
check(/^\/[A-Za-z0-9._~-]+$/.test(String(rpcHandles[0]?.channel)), "通道名满足 CHANNEL_PATTERN");
check(rpcHandles[0]?.channel !== "/api", "未占用保留通道 /api");
check(rpcWebEffects.includes("sync-backup: rpc dispose"), "注册了 RPC dispose effect", JSON.stringify(rpcWebEffects));
check(typeof rpcHandles[0]?.dispatch === "function", "dispatch 是函数");

const dispatch = rpcHandles[0].dispatch;
const stRes = await dispatch("sync-backup.status", {}, undefined);
check(stRes?.ok === true, "status 端点返回 ok 信封");
check(typeof stRes?.value?.text === "string", "status 端点返回 text");
check(typeof stRes?.value?.view === "object" && stRes.value.view !== null, "status 端点返回结构化 view");
check(stRes.value.view.dryRun === true, "view.dryRun 反映配置闸门");
check(stRes.value.view.loaded === true, "view.loaded 标记插件已加载");

const badRes = await dispatch("no-such-endpoint", {}, undefined);
check(badRes?.ok === false && badRes?.error?.code === "bad-request", "未知端点返回 bad-request 信封", JSON.stringify(badRes?.error?.code));

// 本通道绝不能有上传入口：GUI 只能触发本地打包。
const runRes = await dispatch("sync-backup.run", { upload: true }, undefined);
check(runRes?.ok === true, "run 端点返回 ok 信封");
check(runRes?.value?.dryRun === true, "run 端点始终 dryRun=true（GUI 不出网）");
check(runRes?.value?.fileCount === out2.fileCount, "run 端点回传文件数", String(runRes?.value?.fileCount));
check(!("archiveUrl" in (runRes?.value ?? {})), "run 端点不回传远端 URL（无上传）");

/* ---------- 收尾 ---------- */
globalThis.fetch = realFetch;
await fs.rm(tmpHome, { recursive: true, force: true });

console.log("\n=== 结果 ===");
if (failures === 0) {
  console.log("全部检查通过 ✓");
  process.exit(0);
} else {
  console.log(`${failures} 项检查失败 ✗`);
  process.exit(1);
}
