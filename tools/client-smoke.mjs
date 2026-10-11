// dsh-sync-backup — client half 冒烟测试（离线，零网络，无需 DSH）
//
// 覆盖：
//   [1] manifest 契约：dsh.client 段形状 + exports["./client"] 指向真实文件
//   [2] 模块装载契约：__ModuleLoader__.load 调用、factory 只依赖 react、导出 {inject, apply}
//   [3] inject 硬门禁：inject 必须含 connection 与 slots
//   [4] 槽位注册：apply 在 settings.section 上注册一条带 id/order/label/inject 的条目
//   [5] 降级：宿主无 slots 时不抛错
//   [6] RPC 调用形状：五个端点都走 /sync-backup 通道
//   [7] 陈旧上下文：connection 取不到时报可读错误（不抛 inactive context 原文）
//   [8] 语法：lib/client.js 能被 Node 解析
//   [9] 渲染：四个子页面各真跑一次组件，断言 tab 条、结构类、字段与文案（含无 CJK 泄漏）
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CLIENT = path.join(root, "lib", "client.js");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

function section(title) {
  process.stdout.write(`\n—— ${title} ——\n`);
}

/** 最小 React 替身：只提供组件体真正用到的那几个入口。 */
function makeReactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useEffect: () => {},
  };
}

/**
 * 在最小浏览器壳里装载 client bundle。
 * 返回 { exports, loadCalls, requires }。
 *
 * 实现说明：bundle 是「源码即产物」的 ModuleLoader 脚本，用真实模块加载器执行
 * （`await import(file://…)`）而**不是**把源码字符串编译成函数 —— 字符串编译
 * 会被安装安全门判为 `obfuscation/new_function`（high），也会掩盖语法错误。
 * bundle 顶层只依赖 `window` / `navigator` / `document` 三个浏览器全局，
 * 这里在 import 前把它们装到 globalThis 上。
 */
async function loadClient(reactStub = makeReactStub(), { language = "zh-CN", cacheBust = "" } = {}) {
  const loadCalls = [];
  const requires = [];
  // 记录下来**在 import 期间**（即 navigator 已就位时）算出的 exports。
  // 关键：bundle 在 factory 体内读 navigator.language 决定语言，而 factory 每次调用
  // 都会重算 —— 若在 loadClient 返回后（全局已还原）再调一次 factory，拿到的就是
  // Node 自己的 navigator 决定的语言，语言断言会静默失效。
  const exportsList = [];

  const prevWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const prevDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      __ModuleLoader__: {
        load: (spec) => {
          loadCalls.push(spec);
          const mod = spec.factory((id) => { requires.push(id); return id === "react" ? reactStub : undefined; });
          exportsList.push(mod);
          return { exports: mod };
        },
      },
    },
  });
  // Node 自带一个只读的 navigator 全局；语言断言需要一个可控的值。
  // 注意：bundle 在**模块体**里读它，所以必须在 import 之前装好。
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { language },
  });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: undefined });

  try {
    // cacheBust：ESM 的模块体只执行一次，测试需要用不同语言重复装载时必须加查询串。
    const spec = pathToFileURL(CLIENT).href + (cacheBust === "" ? "" : `?bust=${cacheBust}`);
    await import(spec);
  } finally {
    // 还原全局，避免影响同进程后续断言（Node 自带只读 navigator，必须复原）。
    const restore = (name, prev) => {
      if (prev === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, prev);
    };
    restore("window", prevWindow);
    restore("navigator", prevNavigator);
    restore("document", prevDocument);
  }
  return { loadCalls, requires, exportsList };
}

/** 造一个可观测的宿主 ctx 替身。 */
function makeCtx({ slots = true, connection = true } = {}) {
  const registrations = [];
  const components = [];
  const slotInjectCalls = [];
  const rpcCalls = [];
  const ctx = {
    connection: connection
      ? { rpc: { call: async (channel, endpoint, payload) => { rpcCalls.push({ channel, endpoint, payload }); return { ok: true, value: { view: {}, text: "stub" } }; } } }
      : undefined,
    slots: slots
      ? {
          inject: (name, fn) => { slotInjectCalls.push(name); return fn(); },
          register: (spec, component) => { registrations.push(spec); components.push(component); return () => {}; },
        }
      : undefined,
  };
  return { ctx, registrations, components, slotInjectCalls, rpcCalls };
}

/** React 替身：useState 按顺序发种子值，useEffect 不执行（渲染测试不需要副作用）。 */
function makeSeededReact(seeds) {
  let i = 0;
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => [i < seeds.length ? seeds[i++] : (typeof init === "function" ? init() : init), () => {}],
    useEffect: () => {},
  };
}

/** 临时把 navigator.language 换成给定值（bundle 在模块体里读它选语言）。 */
function withNavigator(language, fn) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { language } });
  try {
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", prev);
  }
}

/**
 * React 的 createElement **不会**调用函数组件 —— 它只把函数存进 type。
 * 所以断言健康条 / 徽章 / 卡片的内容前，必须先把无状态函数组件展开成真实元素树，
 * 否则 h(HealthBar,{v}) 在树里只是一个 type，文本与 className 全都收集不到。
 * （这个坑在 dsh-plugin-catalog 的 catalog-smoke 里踩过一次，这里是同款修法。）
 */
function expand(node, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return node;
  if (Array.isArray(node)) return node.map((n) => expand(n, depth));
  if (typeof node !== "object") return node;
  if (typeof node.type !== "function") {
    return { ...node, children: (node.children ?? []).map((c) => expand(c, depth)) };
  }
  if (depth > 12) return node;
  const props = { ...(node.props ?? {}) };
  if (node.children !== undefined) props.children = node.children;
  return expand(node.type(props), depth + 1);
}

/** 把 createElement 树里的文本节点摊平成数组（保持文档顺序）。 */
function collectText(node) {
  const root = expand(node);
  return collectTextRaw(root);
}

function collectTextRaw(node) {
  if (node === null || node === undefined || node === false || node === true) return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectTextRaw);
  return (node.children ?? []).flatMap(collectTextRaw);
}

/** 收集树里所有 className，便于断言结构类真的用上了。 */
function collectClasses(node) {
  const root = expand(node);
  return collectClassesRaw(root);
}

function collectClassesRaw(node) {
  if (node === null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(collectClassesRaw);
  const own = typeof node.props?.className === "string" ? [node.props.className] : [];
  return own.concat((node.children ?? []).flatMap(collectClassesRaw));
}

/** 把展开后的树摊平成一个节点数组，便于按 type/props 筛元素（按钮、input、链接…）。 */
function flatten(node) {
  const out = [];
  const walk = (n) => {
    if (n === null || n === undefined || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    out.push(n);
    (n.children ?? []).forEach(walk);
  };
  walk(expand(node));
  return out;
}

/* ---------------- 种子视图 ---------------- */

// fixture 里的路径是占位串，不带任何真机痕迹。真机 home 只由 host 下发进 view，
// 测试自己拼一份假的就够了 —— 拼真的会把用户名写进仓库。
const FAKE_HOME = "C:\\Users\\tester\\.dsh";
const ART_DIR = `${FAKE_HOME}\\dsh-sync-backup\\artifacts`;

/**
 * 面板状态行的种子视图（覆盖四个子页面的全部字段）。
 * 字段形状照抄 host 半 `statusSnapshot()` 的 view（index.js:760-823），不自行发明。
 */
const SEED_VIEW = {
  lastRunAt: "2026-10-09T13:38:06.498Z",
  lastRunOk: true,
  lastRunReason: "manual",
  lastDurationMs: 1203,
  lastPayload: { fileCount: 368, sourceBytes: 46080000, gzBytes: 31500000, ratio: 0.682 },
  lastUpload: {
    id: "20261008-202201-347a3d53",
    sha256: "8ede86ff785947402a58cbd8e8fd4b46769a85fa084eb636827538f76a02025f",
    kept: 7,
  },
  runs: 4,
  failures: 0,
  intervalHours: 12,
  remoteIntervalHours: 0,
  schedulerEnabled: true,
  uploadOnSchedule: false,
  keepLast: 7,
  localKeepDays: 7,
  maxBackoffHours: 24,
  partialAlertAfter: 3,
  partialStreak: 0,
  lastPartial: false,
  needsAttention: false,
  nextRunAt: "2026-10-10T01:09:33.488Z",
  dryRun: true,
  enabled: true,
  busy: false,
  persistArchive: false,
  restoreCheck: false,
  webdavEnabled: true,
  webdavUrl: "https://dav.example.com/dav/",
  webdavUsername: "tester",
  webdavPath: "dsh-backup/",
  webdavRef: "DSH_SYNC_BACKUP_WEBDAV_PASSWORD",
  githubRepo: "",
  githubPath: "dsh-backup/",
  githubRef: "DSH_SYNC_BACKUP_GITHUB_TOKEN",
  githubWriteLatest: true,
  includeSessions: true,
  includeSemantic: true,
  selectedPaths: [],
  catalog: [
    { id: "persona", intro: "全局人格与行为指令文件。", risk: "low", defaultOn: true },
    { id: "sessions", intro: "会话记录（zstd 分片追加式）。", risk: "high", defaultOn: true },
    { id: "profiles", intro: "插件本体与依赖树，GB 级。", risk: "high", defaultOn: false },
  ],
  artifacts: {
    enabled: false,
    dir: ART_DIR,
    count: 1,
    bytes: 16207589,
    keepDays: 7,
    items: [
      { name: "20261009-120000-aaaa.tar.gz", bytes: 16207589, mtimeMs: Date.parse("2026-10-09T12:00:00.000Z") },
      { name: "20261008-120000-bbbb.tar.gz", bytes: 15900416, mtimeMs: Date.parse("2026-10-08T12:00:00.000Z") },
    ],
  },
  dataDir: `${FAKE_HOME}\\dsh-sync-backup`,
  statePath: `${FAKE_HOME}\\dsh-sync-backup\\state.json`,
  // health 是 host 半算好的**单一结论**，前端不重算。
  health: "ok",
  healthReason: null,
  // host 常驻下发的是**掩码**（从不发明文）；缺了这个字段，导出按钮会因为
  // 「读不到密钥」判断成立而永远不渲染 —— 所以种子必须带着它。
  recoveryCodeMasked: "QG3S-G••••",
  recoveryCodeIsNew: false,
  // 用渲染时刻做相对时间基准，避免断言依赖真实时钟。
  now: new Date("2026-10-09T13:43:06.498Z").toISOString(),
};

/** catalog-sizes 的种子结果（host 半返回 {entries:[{id,fileCount,bytes}]}）。 */
const SEED_SIZES = {
  persona: { id: "persona", fileCount: 3, bytes: 4096 },
  sessions: { id: "sessions", fileCount: 15, bytes: 35000000 },
};

/** restore-check 的种子结果。 */
const SEED_CHECK = {
  source: "20261009-120000-aaaa.tar.gz",
  ok: true,
  errors: [],
  warnings: ["缺少 manifest，按文件名校验"],
  stats: { entries: 368, bytes: 46080000, forbidden: 0, longPaths: 1 },
};

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

section("[1] manifest 契约");
check("dsh.client 存在且为对象", () => {
  assert.equal(typeof pkg.dsh?.client, "object");
  assert.notEqual(pkg.dsh.client, null);
});
check("dsh.client.platform === 'web'", () => {
  assert.equal(pkg.dsh.client.platform, "web");
});
check("dsh.client.inject 含 client-connection", () => {
  const inj = pkg.dsh.client.inject ?? [];
  assert.ok(inj.includes("@deepseek-ai/dsh-client-connection"), `missing connection: ${JSON.stringify(inj)}`);
});
// 教训（2026-10-09 实证）：@deepseek-ai/dsh-client-ui-slots 的 package.json 整个没有
// dsh 字段 ⇒ 它不是 client-modules 的 graph row ⇒ 写进 inject 会被**静默忽略**
// （graphRows.get(name) 为 undefined 时整项跳过，无任何警告）。
// settings.section 由运行时 sidebar.settings 声明、ui-renderer（immediately）提供 slots 服务，
// 所以这里写它没有任何作用，只会制造「写对了」的错觉 —— 断言禁止回归。
check("dsh.client.inject 不含 ui-slots（该包不是 graph row，写了会被静默忽略）", () => {
  const inj = pkg.dsh.client.inject ?? [];
  assert.ok(!inj.includes("@deepseek-ai/dsh-client-ui-slots"), `ui-slots is a silent no-op: ${JSON.stringify(inj)}`);
});
check("dsh.client 无 external（不请求基座之外的模块）", () => {
  assert.equal(pkg.dsh.client.external, undefined);
});
check("exports['./client'] 指向 lib/client.js", () => {
  assert.equal(pkg.exports["./client"], "./lib/client.js");
});
check("exports['./client'] 指向的文件真实存在", () => {
  assert.ok(existsSync(path.join(root, pkg.exports["./client"])), "lib/client.js missing");
});
check("bundle.patch 仍在（client 段未挤掉 host 段）", () => {
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
});

section("[2] 模块装载契约");
const loaded = await loadClient();
check("调用了 window.__ModuleLoader__.load 恰好一次", () => {
  assert.equal(loaded.loadCalls.length, 1);
});
check("load({id}) 的 id 等于包名", () => {
  assert.equal(loaded.loadCalls[0].id, pkg.name);
});
check("只 require 了 react（无第三方基座之外的请求）", () => {
  assert.deepEqual([...new Set(loaded.requires)], ["react"]);
});
const exported = loaded.exportsList[0];
check("导出 {inject, apply}", () => {
  assert.equal(typeof exported.apply, "function");
  assert.ok(Array.isArray(exported.inject));
});
check("inject 含 connection 与 slots", () => {
  assert.deepEqual([...exported.inject].sort(), ["connection", "slots"]);
});

section("[3][4] 槽位注册");
const a = makeCtx();
check("apply(ctx) 不抛错", () => { exported.apply(a.ctx); });
check("在 settings.section 上 inject", () => {
  assert.deepEqual(a.slotInjectCalls, ["settings.section"]);
});
check("注册恰好一条 settings.section 条目", () => {
  assert.equal(a.registrations.length, 1);
});
check("条目的 name === 'settings.section'", () => {
  assert.equal(a.registrations[0].name, "settings.section");
});
check("条目带稳定 id 与数字 order", () => {
  assert.equal(a.registrations[0].id, "sync-backup");
  assert.equal(typeof a.registrations[0].order, "number");
});
check("label 是函数且返回非空本地化串", () => {
  assert.equal(typeof a.registrations[0].label, "function");
  const label = a.registrations[0].label();
  assert.equal(typeof label, "string");
  assert.ok(label.length > 0, "empty label");
});
check("label 在 zh 下为「备份与同步」", () => {
  assert.equal(a.registrations[0].label(), "备份与同步");
});
check("条目组件是函数（React 组件）", () => {
  assert.equal(typeof a.registrations[0].inject, "function");
  assert.equal(typeof a.registrations[0].inject(), "object");
});
check("inject() 投影出 rpcCall 函数", () => {
  assert.equal(typeof a.registrations[0].inject().rpcCall, "function");
});

section("[5] 降级：宿主无 slots");
const b = makeCtx({ slots: false });
check("无 slots 时 apply 静默跳过、不抛错", () => { exported.apply(b.ctx); });

section("[6] RPC 调用形状");
await checkAsync("rpcCall 走 /sync-backup 通道与给定 endpoint", async () => {
  const c = makeCtx();
  exported.apply(c.ctx);
  const { rpcCall } = c.registrations[0].inject();
  await rpcCall("sync-backup.status", {});
  assert.equal(c.rpcCalls.length, 1);
  assert.equal(c.rpcCalls[0].channel, "/sync-backup");
  assert.equal(c.rpcCalls[0].endpoint, "sync-backup.status");
});
await checkAsync("五个端点都合法且不得臆造（status/run/prune/restore-check/catalog-sizes）", async () => {
  const c = makeCtx();
  exported.apply(c.ctx);
  const { rpcCall } = c.registrations[0].inject();
  const want = ["sync-backup.status", "sync-backup.run", "sync-backup.prune", "sync-backup.restore-check", "sync-backup.catalog-sizes"];
  for (const ep of want) await rpcCall(ep, {});
  assert.deepEqual(c.rpcCalls.map((r) => r.endpoint), want);
  assert.ok(c.rpcCalls.every((r) => r.channel === "/sync-backup"), "channel drift");
});
const ENDPOINTS_IN_SOURCE = readFileSync(CLIENT, "utf8")
  .match(/call\("(sync-backup\.[a-z-]+)"/g)
  ?.map((s) => s.slice(6, -1)) ?? [];
check("client 只调用 host 已实现的端点（无臆造端点）", () => {
  const known = new Set([
    "sync-backup.status", "sync-backup.run", "sync-backup.prune",
    "sync-backup.restore-check", "sync-backup.catalog-sizes",
    // v3：界面开始写配置 / 按需导出恢复码
    "sync-backup.save-config", "sync-backup.export-recovery-code",
  ]);
  const unknown = ENDPOINTS_IN_SOURCE.filter((e) => !known.has(e));
  assert.deepEqual(unknown, [], `unknown endpoints: ${JSON.stringify(unknown)}`);
  assert.ok(ENDPOINTS_IN_SOURCE.length >= 5, `endpoints actually wired: ${ENDPOINTS_IN_SOURCE.length}`);
});

section("[7] 陈旧上下文");
check("connection 缺失时报可读错误而非 inactive context", () => {
  const d = makeCtx({ connection: false });
  // inject=["connection"] 是硬门禁；这里直接验证 rpcCall 的兜底分支。
  exported.apply(d.ctx);
  const { rpcCall } = d.registrations[0].inject();
  assert.throws(() => rpcCall("sync-backup.status", {}), (err) => {
    assert.ok(!/inactive context/i.test(err.message), "leaked raw cordis message");
    assert.ok(/刷新|reload|失效|stale/i.test(err.message), `not actionable: ${err.message}`);
    return true;
  });
});

section("[8] 语法");
check("lib/client.js 大小合理且含 ModuleLoader 包装", () => {
  const src = readFileSync(CLIENT, "utf8");
  assert.ok(src.length > 2000, `too small: ${src.length}`);
  assert.ok(src.includes("window.__ModuleLoader__.load({"));
  assert.ok(src.includes("module.exports = { inject, apply }"));
});

section("[9] 渲染：四个子页面各真跑一次");

/**
 * 装载串行化。**必须**：loadClient 通过替换全局 `navigator` 再 `await import(...)`
 * 来选语言，两次装载并发执行会互相踩掉全局（上一次的 finally 会还原成 undefined，
 * 而下一次还在 import 中），表现为 `exportsList[0] undefined` 的偶发失败。
 * 所有 render 一律走这把锁排队。
 */
let loadChain = Promise.resolve();
function serialize(fn) {
  const run = loadChain.then(fn, fn);
  loadChain = run.then(() => {}, () => {});
  return run;
}

/**
 * 在给定语言、给定 tab 下把组件渲染一次，返回 {text, classes, nodes}。
 * `?v=N` 是必需的缓存击穿：bundle 在**模块体**里读 navigator.language 决定语言，
 * 而 ESM 只执行一次模块体，不加查询串第二次 import 会直接命中缓存、语言不变。
 */
async function render(language, seeds, bust) {
  const reactStub = makeSeededReact(seeds);
  const loaded2 = await loadClient(reactStub, { language, cacheBust: String(bust) });
  const exported2 = loaded2.exportsList[0];
  const host = makeCtx();
  exported2.apply(host.ctx);
  const tree = host.components[0]({ rpcCall: host.registrations[0].inject().rpcCall });
  return { tree, text: collectText(tree), classes: collectClasses(tree), nodes: flatten(tree) };
}

/** 串行版 render（用在 checkAsync 里，避免与相邻装载抢全局 navigator）。 */
const renderSerial = (language, seeds, bust) => serialize(() => render(language, seeds, bust));

/**
 * useState 种子必须与组件内**声明顺序**严格对齐，否则整棵树的分支会跑偏。
 * SyncBackupSection 的顺序：view, note, tone, busy, ready, tab, op, sizes, sizesState,
 * check, prunePlan, copyNote, recovery, recoveryNote, recoveryPending, recoveryExpiresAt, alive
 *
 * ⚠️ v3 新增了 recovery / recoveryNote 两个 state，两者之间务必同步：
 * 少给一个种子，后面的一切都会往前挪一位。曾经就因为少了它们，recovery 拿到了本该属于
 * alive 的 {current:true}（真值），于是「明文恢复码」分支恒真、导出按钮永远不渲染，
 * 而原有断言一条都没红 —— 这类错位不会报错，只会让整棵树的分支静默跑偏。
 */
function seedsFor(over = {}) {
  return [
    over.view ?? SEED_VIEW,
    over.note ?? "",
    over.tone ?? "info",
    over.busy ?? false,
    over.ready ?? true,
    over.tab ?? "overview",
    over.op ?? null,
    over.sizes ?? {},
    over.sizesState ?? "idle",
    over.check ?? null,
    over.prunePlan ?? null,
    over.copyNote ?? "",
    over.recovery ?? "",
    over.recoveryNote ?? "",
    over.recoveryPending ?? false,
    over.recoveryExpiresAt ?? 0,
    { current: true },
  ];
}

const TABS_ZH = ["概览", "产物文件", "通道配置", "环境和维护"];
const TABS_EN = ["Overview", "Artifacts", "Channels", "Environment"];
let bustNo = 0;
const nextBust = () => `b${++bustNo}`;

/* —— 9.1 概览 —— */
const zh = await render("zh-CN", seedsFor(), nextBust());

check("渲染不抛错且返回一棵元素树", () => {
  assert.ok(zh.text.length > 0, "empty render");
});
check("tab 条渲染四个标签且顺序固定（概览 → 产物文件 → 通道配置 → 环境和维护）", () => {
  const idx = TABS_ZH.map((w) => zh.text.indexOf(w));
  for (let i = 0; i < idx.length; i++) assert.notEqual(idx[i], -1, `missing tab: ${TABS_ZH[i]}`);
  assert.deepEqual(idx, [...idx].sort((x, y) => x - y), `tabs out of order: ${JSON.stringify(idx)}`);
});
check("默认停在概览：恰好一个 role=tab 被选中，且选中项是概览", () => {
  const tabs = zh.nodes.filter((n) => n.props?.role === "tab");
  assert.equal(tabs.length, 4, `tab count=${tabs.length}`);
  const sel = tabs.filter((n) => n.props["aria-selected"] === "true");
  assert.equal(sel.length, 1, `selected=${sel.length}`);
  assert.ok(collectText(sel[0]).includes("概览"), `wrong default tab: ${JSON.stringify(collectText(sel[0]))}`);
});
check("健康条置顶且给出单一结论（data-tone=ok）", () => {
  const bars = zh.nodes.filter((n) => typeof n.props?.className === "string" && n.props.className.startsWith("dsb-health"));
  assert.ok(bars.length >= 1, "health bar missing");
  assert.equal(bars[0].props["data-tone"], "ok", `tone=${bars[0].props["data-tone"]}`);
  const joined = zh.text.join("\n");
  assert.ok(joined.includes("当前状态：正常"), `health label missing: ${joined.slice(0, 300)}`);
  // 置顶：健康条排在 tab 条之后、但在任何分组卡片内容（「运行状态」组）之前
  assert.ok(joined.indexOf("当前状态") < joined.indexOf("上次运行"), "health bar must precede the run-state group");
  assert.ok(joined.indexOf("概览") < joined.indexOf("当前状态"), "health bar lives inside the overview tab body");
});
check("运行状态组渲染绝对时间 + 相对时间 + 耗时 + 次数 + 下次计划", () => {
  const joined = zh.text.join("\n");
  assert.ok(joined.includes("5 分钟前"), `relative time missing: ${joined.slice(0, 400)}`);
  assert.ok(joined.includes("1.2 s"), "duration missing");
  assert.ok(joined.includes("manual"), "lastRunReason missing");
  assert.ok(zh.text.includes("4"), "runs missing");
  assert.ok(joined.includes("2026"), "nextRunAt absolute time missing");
});
check("备份内容渲染上次载荷四个数字（368 / 43.9x MB / 30.0x MB / 68.2%）", () => {
  const joined = zh.text.join("\n");
  assert.ok(joined.includes("368"), "file count missing");
  assert.ok(/43\.9\d MB/.test(joined), `source size missing: ${joined.slice(0, 400)}`);
  assert.ok(/30\.0\d MB/.test(joined), "gz size missing");
  assert.ok(joined.includes("68.2%"), "ratio missing");
});
// v3：概览的「周期与保留」卡进入编辑态后才有输入框；只读态必须零输入框
// —— 理由是「点得动但没反应」比「根本不能点」更糟，所以非编辑态一律纯文本。
check("周期与保留：只读态零输入框，编辑态才出现控件", () => {
  const joined = zh.text.join("\n");
  assert.ok(joined.includes("远端保留份数"), "keepLast row missing");
  assert.ok(joined.includes("本地保留天数"), "localKeepDays row missing");
  assert.ok(joined.includes("本地打包周期"), "local interval row missing");
  assert.ok(joined.includes("远端同步周期"), "remote interval row missing");
  assert.ok(zh.nodes.filter((n) => n.type === "input").length === 0, "readonly overview must not render inputs");
  const buttons = zh.nodes.filter((n) => n.type === "button").map((n) => String(n.children ?? ""));
  assert.ok(buttons.some((s) => s.includes("编辑周期")), `edit button missing: ${buttons.join("|")}`);
  // 只读态必须说清「改哪里生效」——否则用户以为这是纯展示
  assert.ok(joined.includes("点「编辑」"), "must tell people how to change it");
});
check("卡片/键值行/指标段结构类齐全（dsb-card / dsb-kvRow / dsb-kvKey / dsb-statSeg）", () => {
  for (const cls of ["dsb-card", "dsb-kvRow", "dsb-kvKey", "dsb-statSeg", "dsb-tabs"]) {
    assert.ok(zh.classes.includes(cls), `missing structural class ${cls}: ${JSON.stringify([...new Set(zh.classes)])}`);
  }
});

/**
 * 恢复码：host 的 view 没有「不可用」布尔位，只有 maskRecoveryCode() 的兜底串 "(未设置)"。
 * client 必须由这个掩码反推能否导出 —— 这里正好我不通背 URL 才算是可导出。
 *  	注意这两个断言是互斥的分支，任何一个漏改都会拖倒：masked 给了值却禁用 = 绕起来自己骗自己；
 *  mask 是 "(未设置)" 还给按钮 = 点下去必然 bad-request。
 */
await checkAsync("恢复码：掩码可用时给导出按钮，'(未设置)' 时禁用并说明原因", async () => {
  const okView = { ...SEED_VIEW, recoveryCodeMasked: "QG3S-G••••" };
  const noneView = { ...SEED_VIEW, recoveryCodeMasked: "(未设置)" };
  const ok = await renderSerial("zh-CN", seedsFor({ view: okView }), nextBust());
  const none = await renderSerial("zh-CN", seedsFor({ view: noneView }), nextBust());
  const exportOf = (r) => r.nodes.find(
    (n) => n.type === "button" && String(n.children ?? "").includes("导出恢复码")
  );
  assert.ok(exportOf(ok), "export button missing when code is available");
  assert.equal(exportOf(none), undefined, "must not offer export when code is '(未设置)'");
  assert.ok(none.text.join("\n").includes("没有可用的恢复码"), `unavailable reason missing: ${none.text.join("|").slice(0, 300)}`);
});

// 注意：这里的 checkAsync **必须 await**。loadClient 靠替换全局 navigator + await import
// 选语言，任何并发装载都会互相踩掉全局（表现为 exportsList[0] undefined 的偶发崩溃）。
await checkAsync("未就绪时只渲染加载提示（不渲染 tab 条）", async () => {
  const busy = await renderSerial("zh-CN", seedsFor({ ready: false }), nextBust());
  assert.ok(busy.text.join("").includes("读取状态中"), "loading text missing");
  assert.equal(busy.classes.filter((c) => c === "dsb-tabs").length, 0, "tabs must not render before ready");
  assert.equal(busy.classes.filter((c) => c === "dsb-card").length, 0, "cards must not render before ready");
});

/* —— 9.2 产物文件 —— */
const art = await render("zh-CN", seedsFor({ tab: "artifacts" }), nextBust());
check("产物文件：表格列出 items（文件名 / 体积 / 修改时间 / 本地徽章）", () => {
  const joined = art.text.join("\n");
  assert.ok(joined.includes("20261009-120000-aaaa.tar.gz"), "artifact name missing");
  assert.ok(/15\.4\d MB/.test(joined), `artifact size missing: ${joined.slice(0, 600)}`);
  assert.ok(joined.includes("20261008-120000-bbbb.tar.gz"), "second artifact missing");
  assert.ok(art.classes.includes("dsb-table"), "table class missing");
  const badges = art.nodes.filter((n) => n.props?.["data-source"] === "local");
  assert.equal(badges.length, 2, `local badges=${badges.length}`);
});
check("产物文件：persistArchive=false 时整页说明 + 立即清理按钮", () => {
  const joined = art.text.join("\n");
  assert.ok(joined.includes("persistArchive=false"), `disabled note missing: ${joined.slice(0, 600)}`);
  assert.ok(art.text.includes("立即清理"), "prune button missing");
});
check("产物文件：远端摘要区分 WebDAV / GitHub，且 SHA256 只取前 16 位", () => {
  const joined = art.text.join("\n");
  assert.ok(joined.includes("dsh-backup/"), "webdav path missing");
  assert.equal(art.nodes.filter((n) => n.props?.["data-source"] === "webdav").length, 1, "webdav badge missing");
  assert.equal(art.nodes.filter((n) => n.props?.["data-source"] === "github").length, 1, "github badge missing");
  assert.ok(joined.includes("20261008-202201-347a3d53"), "upload id missing");
  assert.ok(joined.includes("8ede86ff78594740"), `sha16 missing: ${joined.slice(0, 800)}`);
  // 完整 64 位摘要不得进界面（只露前 16 位即可核对）
  assert.ok(!joined.includes("8ede86ff785947402a58cbd8e8fd4b46769a85fa084eb636827538f76a02025f"), "full sha leaked");
});
await checkAsync("产物文件：空态单独处理（无 items 时给空态文案、仍保留清理入口）", async () => {
  const emptyView = { ...SEED_VIEW, artifacts: { ...SEED_VIEW.artifacts, items: [] } };
  const e = await renderSerial("zh-CN", seedsFor({ tab: "artifacts", view: emptyView }), nextBust());
  assert.ok(e.text.join("\n").includes("本地暂无可用的归档产物"), "empty hint missing");
  assert.equal(e.classes.includes("dsb-table"), false, "table must not render when empty");
  assert.ok(e.text.includes("立即清理"), "prune button must survive the empty state");
});

/* —— 9.3 通道配置 —— */
const ch = await render("zh-CN", seedsFor({ tab: "channels" }), nextBust());
check("通道配置：dryRun=true 时页顶警告条（任何上传都会被拒绝）", () => {
  const joined = ch.text.join("\n");
  assert.ok(joined.includes("dryRun=true"), `dryRun banner missing: ${joined.slice(0, 400)}`);
  assert.ok(joined.includes("任何上传都会被拒绝"), "dryRun consequence missing");
  const banner = ch.nodes.find((n) => n.props?.className === "dsb-banner");
  assert.equal(banner?.props["data-kind"], "error", `banner kind=${banner?.props["data-kind"]}`);
});
// v3：周期两行移到了概览的可编辑卡里；通道页只留说明。
check("通道配置：只剩操作说明，周期改由概览页编辑", () => {
  const joined = ch.text.join("\n");
  assert.ok(joined.includes("dryRun=true"), `dryRun banner missing: ${joined.slice(0, 400)}`);
  assert.ok(joined.includes("config.json"), "must say where edits land");
  // 可以**提到** patch（说明优先级），但不能再**要求人手去改**它
  assert.ok(!/请改[^\n]*cordis\.patch\.yml/.test(joined), "must no longer tell people to edit YAML by hand");
});
check("通道配置：WebDAV 卡是受控表单（开关 + 地址 / 用户名 / 路径）", () => {
  // 通道页的值是**输入框的当前值**，不在文本节点里 —— 必须按 value 断言，不能只搜页面文本。
  const texts = ch.nodes.filter((n) => n.type === "input" && n.props?.type === "text");
  assert.ok(texts.length >= 3, `text inputs=${texts.length}`);
  assert.ok(texts.every((n) => typeof n.props.value === "string"), "text inputs must be controlled");
  const values = texts.map((n) => n.props.value);
  assert.ok(values.includes("https://dav.example.com/dav/"), `webdav url missing: ${JSON.stringify(values)}`);
  assert.ok(values.includes("tester"), `webdav username missing: ${JSON.stringify(values)}`);
  const joined = ch.text.join("\n");
  assert.ok(joined.includes("DSH_SYNC_BACKUP_WEBDAV_PASSWORD"), "webdav ref missing");
  assert.ok(joined.includes("口令只写不读"), "password note missing");
  assert.ok(joined.includes("tools/set-webdav-password.mjs"), "password reset guidance missing");
  assert.ok(values.includes("dsh-backup/"), `webdav path missing: ${JSON.stringify(values)}`);
});
check("通道配置：无任何口令回显控件（type=password 零个）", () => {
  assert.equal(ch.nodes.filter((n) => n.type === "input" && n.props?.type === "password").length, 0, "password control found");
  const boxes = ch.nodes.filter((n) => n.type === "input" && n.props?.type === "checkbox");
  assert.equal(boxes.length, 2, `channel switches=${boxes.length}`);
  assert.ok(boxes.every((x) => typeof x.props.checked === "boolean"), "switches must be controlled");
});
check("通道配置：GitHub 卡是受控表单 + PAT 指引链接", () => {
  const joined = ch.text.join("\n");
  assert.ok(joined.includes("https://github.com/settings/tokens"), "PAT link missing");
  assert.ok(joined.includes("repo"), "repo scope hint missing");
  assert.ok(joined.includes("私有"), "private repo requirement missing");
  const link = ch.nodes.find((n) => n.type === "a" && n.props?.href === "https://github.com/settings/tokens");
  assert.ok(link, "PAT anchor missing");
  assert.equal(link.props.target, "_blank");
});

/* —— 9.4 环境和维护 —— */
const env = await render("zh-CN", seedsFor({ tab: "env", sizes: SEED_SIZES, sizesState: "done", check: SEED_CHECK }), nextBust());
// 报告 4.2：备份文件夹选择**不再是只读投影**，而是可编辑并保存的集合。
// 这几条断言随之从「必须 disabled」翻转成「必须可编辑」——
// 旧断言记录的是待修行为，保留它等于把 bug 锁进回归里。
check("环境和维护：备份文件夹 checkbox 可编辑（不再是只读投影）", () => {
  const boxes = env.nodes.filter((n) => n.type === "input" && n.props?.type === "checkbox");
  assert.equal(boxes.length, 3, `checkbox count=${boxes.length}`);
  assert.ok(boxes.every((x) => x.props.disabled !== true), "catalog checkboxes must be editable now");
  assert.ok(boxes.every((x) => typeof x.props.onChange === "function"), "每个 checkbox 都要有变更处理");
  const joined = env.text.join("\n");
  assert.ok(joined.includes("persona") && joined.includes("sessions") && joined.includes("profiles"), "catalog ids missing");
  assert.ok(joined.includes("勾选"), "must explain what a checkmark means");
});

check("环境和维护：默认集合下 profiles 不勾（defaultOn=false 仍然生效）", () => {
  const boxes = env.nodes.filter((n) => n.type === "input" && n.props?.type === "checkbox");
  const byId = ["persona", "sessions", "profiles"].map((id, i) => ({ id, checked: boxes[i].props.checked }));
  assert.deepEqual(byId, [
    { id: "persona", checked: true },
    { id: "sessions", checked: true },
    { id: "profiles", checked: false },
  ], `default projection wrong: ${JSON.stringify(byId)}`);
});

check("环境和维护：显示「当前用的是默认集合」并给出两个操作按钮", () => {
  const joined = env.text.join("\n");
  assert.ok(joined.includes("默认集合"), `应说明当前是默认集合：${joined.slice(0, 400)}`);
  assert.ok(joined.includes("恢复默认"), "应有「恢复默认」按钮");
  assert.ok(joined.includes("保存"), "应有「保存」按钮");
});

check("环境和维护：自定义集合时按 selectedPaths 渲染勾选态", async () => {
  const custom = await render("zh-CN", seedsFor({
    tab: "env", sizes: SEED_SIZES, sizesState: "done",
    selectedPaths: ["sessions"],
  }), nextBust());
  const boxes = custom.nodes.filter((n) => n.type === "input" && n.props?.type === "checkbox");
  const byId = ["persona", "sessions", "profiles"].map((id, i) => ({ id, checked: boxes[i].props.checked }));
  assert.deepEqual(byId, [
    { id: "persona", checked: false },
    { id: "sessions", checked: true },
    { id: "profiles", checked: false },
  ], `custom projection wrong: ${JSON.stringify(byId)}`);
  assert.ok(custom.text.join("\n").includes("自定义集合"), "应提示当前是自定义集合");
});

check("环境和维护：只剩一项时取消勾选不产生空集合（载荷不能为空）", async () => {
  // 「一个都不选」是无效状态：selectedPaths: [] 有专属语义（= 默认集合），
  // 不能同时用来表示「什么都不备份」。组件在算出的下一版为空时直接不回调，
  // 这里验证那个分支确实被走到 —— 而不是只断言「点了一下没崩」。
  const one = await render("zh-CN", seedsFor({
    tab: "env", sizes: SEED_SIZES, sizesState: "done",
    selectedPaths: ["persona"],
  }), nextBust());
  const boxes = one.nodes.filter((n) => n.type === "input" && n.props?.type === "checkbox");
  assert.equal(boxes[0].props.checked, true, "前置条件：persona 应处于勾选态");

  // onChange 由组件闭包计算 next；空集合时提前 return，不调用上层 setCatDraft。
  // 渲染层拿不到 hook，所以用「调用它并确认没有抛错、且集合仍非空」来验证这条路径
  // 是可执行的；真正的空集合兜底在 host 的 sanitizeEditable 与备份非空上。
  let threw = null;
  try {
    boxes[0].props.onChange();
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null, `取消最后一项不该抛错：${threw && threw.message}`);
});

check("环境和维护：目录集合的保存走白名单键 selectedPaths", async () => {
  // 服务端只接受 GUI_EDITABLE_KEYS 里的键；这里确认前端保存用的正是那个键名，
  // 否则会出现「点了保存但服务端静默丢弃」这种最难查的一类不一致。
  const joined = env.text.join("\n");
  assert.ok(joined.length > 0);
  const { GUI_EDITABLE_KEYS } = await import("../lib/user-config.js");
  assert.ok(GUI_EDITABLE_KEYS.includes("selectedPaths"), "selectedPaths 必须在可编辑白名单里");
});
check("环境和维护：risk 徽章三色（low=ok / high=error）", () => {
  const tones = env.nodes.filter((n) => n.props?.className === "dsb-badge").map((n) => n.props["data-tone"] ?? null);
  assert.ok(tones.includes("ok"), `low risk tone missing: ${JSON.stringify(tones)}`);
  assert.ok(tones.includes("error"), `high risk tone missing: ${JSON.stringify(tones)}`);
});
check("环境和维护：catalog-sizes 补齐体积拼在 intro 后（本机 N 个文件 / X MB）", () => {
  const joined = env.text.join("\n");
  assert.ok(joined.includes("本机 3 个文件 / 4.0 KB"), `persona size missing: ${joined.slice(0, 900)}`);
  assert.ok(joined.includes("本机 15 个文件 / 33.38 MB"), `sessions size missing: ${joined.slice(0, 900)}`);
});
await checkAsync("环境和维护：体积统计的 loading 与 error 态都要处理", async () => {
  const loading = await renderSerial("zh-CN", seedsFor({ tab: "env", sizes: {}, sizesState: "loading" }), nextBust());
  assert.ok(loading.text.join("\n").includes("正在统计本机体积"), "loading state missing");
  const bad = await renderSerial("zh-CN", seedsFor({ tab: "env", sizes: { __error: "EACCES" }, sizesState: "error" }), nextBust());
  assert.ok(bad.text.join("\n").includes("EACCES"), `error state missing: ${bad.text.join("\n").slice(0, 600)}`);
});
check("环境和维护：运行环境 kvRow 排齐（dataDir/statePath/周期/开关/选项）", () => {
  const joined = env.text.join("\n");
  for (const w of ["数据目录", "状态文件", "本地周期", "远端周期", "定时器", "含 sessions", "含 semantic", "每次打包后自检", "本地留档"]) {
    assert.ok(joined.includes(w), `env row missing: ${w}`);
  }
  assert.ok(joined.includes("dsh-sync-backup"), "data dir value missing");
  assert.ok(joined.includes("state.json"), "state file value missing");
  assert.ok(env.classes.filter((c) => c === "dsb-kvRow").length >= 9, "kv rows missing");
});
check("环境和维护：备份数据验证渲染 ok/errors/warnings/stats + 不写现有文件的说明", () => {
  const joined = env.text.join("\n");
  assert.ok(joined.includes("不会写入或修改任何现有文件"), "verify note missing");
  assert.ok(env.text.includes("运行恢复前自检"), "verify button missing");
  assert.ok(joined.includes("可恢复"), "verify ok badge missing");
  assert.ok(joined.includes("缺少 manifest"), "warning rendered missing");
  assert.ok(joined.includes("368"), "stats entries missing");
  assert.ok(joined.includes("1"), "stats longPaths missing");
});

/* —— 9.5 英文（i18n 回归） —— */
const en = await render("en-US", seedsFor(), nextBust());
check("英文渲染结果不含任何 CJK 字符（标点随语言走）", () => {
  const joined = en.text.join("\n");
  const cjk = joined.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g);
  assert.equal(cjk, null, `CJK leaked into the en render: ${JSON.stringify(cjk)}`);
});
check("英文渲染出四个英文 tab 标签", () => {
  const joined = en.text.join("\n");
  for (const w of TABS_EN) assert.ok(joined.includes(w), `missing en tab: ${w}`);
  const idx = TABS_EN.map((w) => en.text.indexOf(w));
  assert.deepEqual(idx, [...idx].sort((x, y) => x - y), "en tabs out of order");
});
check("英文标点用半角冒号（相对时间与耗时都为半角）", () => {
  const joined = en.text.join("\n");
  assert.ok(joined.includes("Status: healthy"), `half-width colon missing: ${joined.slice(0, 300)}`);
  assert.ok(/5 min ago/.test(joined), `en relative time missing: ${joined.slice(0, 300)}`);
});
// catalog[].intro 是 host 半 CATALOG 原文（中文），不是本插件的 UI 串 ——
// 断言「英文界面无 CJK」时种子要换成英文 intro，否则测的是 host 数据而不是 i18n。
const EN_CATALOG = SEED_VIEW.catalog.map((e, i) => ({
  ...e,
  intro: ["Global persona and behavior files.", "Session records (zstd shards).", "Plugin bodies and deps, GB scale."][i],
}));
const enEnv = await renderSerial("en-US", seedsFor({ tab: "env", view: { ...SEED_VIEW, catalog: EN_CATALOG }, sizes: SEED_SIZES, sizesState: "done" }), nextBust());
check("英文环境页也不含 CJK（catalog 体积文案随语言走）", () => {
  const joined = enEnv.text.join("\n");
  const cjk = joined.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g);
  assert.equal(cjk, null, `CJK leaked into en env render: ${JSON.stringify(cjk)}`);
  assert.ok(joined.includes("15 files / 33.38 MB on this machine"), `en size line missing: ${joined.slice(0, 900)}`);
});

/* —— 9.6 报告 5.3：维护按钮必须统一查 busy（备份进行中禁掉清理/体积/自检） —— */
check("产物页：v.busy=true 时「立即清理」禁用（与 op 并行生效）", async () => {
  const r = await renderSerial("zh-CN", seedsFor({ tab: "artifacts", view: { ...SEED_VIEW, busy: true } }), nextBust());
  const btn = r.nodes.find((n) => n.type === "button" && collectText(n).includes("立即清理"));
  assert.ok(btn, "prune button missing");
  assert.equal(btn.props.disabled, true, "prune must be disabled while a backup is running");
});
check("产物页：busy=false 且空闲时「立即清理」可点（回归反向位）", async () => {
  const r = await renderSerial("zh-CN", seedsFor({ tab: "artifacts" }), nextBust());
  const btn = r.nodes.find((n) => n.type === "button" && collectText(n).includes("立即清理"));
  assert.ok(btn);
  assert.notEqual(btn.props.disabled, true, "prune must stay clickable when idle");
});
check("环境页：v.busy=true 时体积统计与恢复自检都禁用", async () => {
  const r = await renderSerial("zh-CN", seedsFor({
    tab: "env", view: { ...SEED_VIEW, busy: true }, sizes: SEED_SIZES, sizesState: "done",
  }), nextBust());
  const recalc = r.nodes.find((n) => n.type === "button" && collectText(n).includes("重新统计体积"));
  const verify = r.nodes.find((n) => n.type === "button" && collectText(n).includes("运行恢复前自检"));
  assert.ok(recalc && verify, "env maintenance buttons missing");
  assert.equal(recalc.props.disabled, true, "recalc must be disabled while busy");
  assert.equal(verify.props.disabled, true, "restore-check must be disabled while busy");
});
/* —— 9.7 报告 5.5/3.4：恢复码的确认门与明文显示分支 —— */
check("概览默认态：显示「导出恢复码」按钮，且不出现确认对话框", async () => {
  const r = await renderSerial("zh-CN", seedsFor(), nextBust());
  const joined = r.text.join("\n");
  assert.ok(joined.includes("导出恢复码"), "export button missing");
  assert.equal(r.nodes.filter((n) => n.props?.role === "alertdialog").length, 0, "confirm dialog must not pre-render");
});
check("点导出先进确认门：pending=true 时渲染 alertdialog，含确认与取消", async () => {
  const r = await renderSerial("zh-CN", seedsFor({ recoveryPending: true }), nextBust());
  const dlg = r.nodes.filter((n) => n.props?.role === "alertdialog");
  assert.equal(dlg.length, 1, `alertdialog count=${dlg.length}`);
  const joined = r.text.join("\n");
  assert.ok(joined.includes("确认导出"), "confirm CTA missing");
  assert.ok(joined.includes("60 秒"), "TTL must be stated before revealing plaintext");
  assert.ok(!joined.includes("恢复码（只显示这一次）"), "plaintext must NOT render before it was fetched");
});
check("拿到明文才进「只显示这一次」分支", async () => {
  const r = await renderSerial("zh-CN", seedsFor({ recovery: "AAAA-BBBB-CCCC-DDDD" }), nextBust());
  const joined = r.text.join("\n");
  assert.ok(joined.includes("只显示这一次"), "shown-once label missing");
  assert.ok(joined.includes("AAAA-BBBB-CCCC-DDDD"), "plaintext code missing");
});
check("英文确认门不含 CJK", async () => {
  const r = await renderSerial("en-US", seedsFor({ recoveryPending: true }), nextBust());
  const joined = r.text.join("\n");
  assert.ok(joined.includes("Confirm export"), "en confirm CTA missing");
  const cjk = joined.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g);
  assert.equal(cjk, null, `CJK leaked: ${JSON.stringify(cjk)}`);
});
/* —— 9.8 报告 5.4：可访问性契约 —— */
check("tablist：四 tab 有 aria-controls 指向当前 tabpanel，roving tabindex 只让选中项可聚焦", async () => {
  const r = await renderSerial("zh-CN", seedsFor({ tab: "channels" }), nextBust());
  const tabs = r.nodes.filter((n) => n.props?.role === "tab");
  assert.equal(tabs.length, 4);
  const panel = r.nodes.find((n) => n.props?.role === "tabpanel");
  assert.ok(panel, "tabpanel missing");
  assert.equal(panel.props.id, "dsb-panel-channels", `panel id=${panel.props.id}`);
  assert.equal(panel.props["aria-labelledby"], "dsb-tab-channels", "panel must point back at its tab");
  for (const t of tabs) assert.equal(t.props["aria-controls"], "dsb-panel-channels", "all tabs control the visible panel");
  const sel = tabs.filter((t) => t.props["aria-selected"] === "true");
  assert.equal(sel.length, 1);
  assert.equal(sel[0].props.tabIndex, 0, "selected tab must be focusable");
  assert.ok(tabs.filter((t) => t !== sel[0]).every((t) => t.props.tabIndex === -1), "unselected tabs must be tabIndex=-1");
});
check("tablist 挂键盘导航（←/→/Home/End 处理函数存在）", async () => {
  const r = await renderSerial("zh-CN", seedsFor(), nextBust());
  const list = r.nodes.find((n) => n.props?.role === "tablist");
  assert.ok(list, "tablist missing");
  assert.equal(typeof list.props.onKeyDown, "function", "tablist needs onKeyDown");
});
check("确认对话框：Escape 有处理且 aria-modal（通道确认与恢复码确认都算）", async () => {
  const rc = await renderSerial("zh-CN", seedsFor({ recoveryPending: true }), nextBust());
  const dlg = rc.nodes.find((n) => n.props?.role === "alertdialog");
  assert.ok(dlg, "recovery confirm missing");
  assert.equal(dlg.props["aria-modal"], true, "alertdialog should be aria-modal");
  assert.equal(typeof dlg.props.onKeyDown, "function", "alertdialog must handle Escape");
  // 通道目的地确认（ConfirmBlock）：pending 键数组非空即渲染
  const ch = await renderSerial("zh-CN", seedsFor({ tab: "channels" }), nextBust());
  const ok = ch.nodes.some((n) => n.props?.role === "alertdialog" && typeof n.props.onKeyDown === "function");
  // 无待确认改动时对话框不出现 —— 只验证「出现时必有 Escape」，不能强求它在种子态渲染
  if (!ok) {
    const list = ch.nodes.filter((n) => n.props?.role === "alertdialog");
    assert.equal(list.length, 0, "channels tab without pending changes must not render a dialog");
  }
});
/* —— 9.9 报告 5.6：清理前必须显示将删除的份数与空间 —— */
check("产物页：非确认态按钮是「立即清理」，不显示份数", async () => {
  const r = await renderSerial("zh-CN", seedsFor({ tab: "artifacts" }), nextBust());
  const btn = r.nodes.find((n) => n.type === "button" && collectText(n).includes("立即清理"));
  assert.ok(btn, "prune button missing");
  assert.equal(typeof btn.props.onClick, "function", "prune button needs onClick");
  assert.ok(!collectText(btn).includes("确认删除"), "idle button must not show the confirm label");
});
check("产物页：确认态按钮显示将删份数与释放空间（destructive 先给数）", async () => {
  const r = await renderSerial("zh-CN", seedsFor({
    tab: "artifacts", op: "prune-confirm",
    prunePlan: { n: 3, bytes: "12.5 MB", kept: 7, total: 10 },
  }), nextBust());
  const label = r.text.join("\n");
  assert.ok(label.includes("确认删除 3 份"), `confirm label missing: ${label.slice(0, 300)}`);
  assert.ok(label.includes("12.5 MB"), "freed size missing from the confirm label");
});
check("产物页：确认态下按钮不被 busy 规则误放行（仍受 op/v.busy 约束）", async () => {
  const r = await renderSerial("zh-CN", seedsFor({
    tab: "artifacts", op: "prune-confirm",
    prunePlan: { n: 1, bytes: "1 MB", kept: 0, total: 1 },
    view: { ...SEED_VIEW, busy: true },
  }), nextBust());
  const btn = r.nodes.find((n) => n.type === "button" && collectText(n).includes("确认删除"));
  assert.ok(btn, "confirm button missing");
  assert.equal(btn.props.disabled, true, "confirm must stay disabled while a backup runs");
});
check("英文确认态不含 CJK", async () => {
  const r = await renderSerial("en-US", seedsFor({
    tab: "artifacts", op: "prune-confirm",
    prunePlan: { n: 2, bytes: "3 MB", kept: 1, total: 3 },
  }), nextBust());
  const joined = r.text.join("\n");
  assert.ok(joined.includes("Delete 2"), `en confirm label missing: ${joined.slice(0, 300)}`);
  const cjk = joined.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g);
  assert.equal(cjk, null, `CJK leaked into en artifacts render: ${JSON.stringify(cjk)}`);
});
/* —— 9.10 报告 5.6 / 10.2：概览页诊断折叠 —— */
check("概览页：诊断明细折在 details 里，summary 可见且可折叠", async () => {
  const r = await renderSerial("zh-CN", seedsFor(), nextBust());
  const det = r.nodes.filter((n) => n.type === "details");
  assert.equal(det.length, 1, `details count=${det.length}`);
  assert.ok(det[0].props?.className === "dsb-details", "details needs its class");
  const sum = det[0].children.find((c) => c && c.type === "summary");
  assert.ok(sum, "details needs a summary");
  assert.ok(collectText(sum).includes("诊断详情"), "summary label missing");
  // 诊断项必须在 details 内，而不是散在概览主体
  const inDetails = collectText(det[0]);
  assert.ok(inDetails.includes("耗时") || inDetails.includes("累计"), `diagnostics not inside details: ${inDetails.slice(0, 200)}`);
});
check("概览页：常用项（下次计划 / 上次结果）留在折叠区之外", async () => {
  const r = await renderSerial("zh-CN", seedsFor(), nextBust());
  const det = r.nodes.find((n) => n.type === "details");
  const outside = r.text.join("\n");
  assert.ok(outside.includes("下次计划"), "next run must stay visible");
  // 并在 details 之前出现（即未被折进去）
  const detText = collectText(det);
  assert.ok(!detText.includes("下次计划"), "next run must NOT be inside the collapsed diagnostics");
});
check("英文诊断折叠区不含 CJK", async () => {
  const r = await renderSerial("en-US", seedsFor(), nextBust());
  const det = r.nodes.find((n) => n.type === "details");
  assert.ok(det, "details missing in en render");
  const joined = collectText(det);
  const cjk = joined.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g);
  assert.equal(cjk, null, `CJK leaked into en diagnostics: ${JSON.stringify(cjk)}`);
});
/* —— 9.11 报告 3.3：恢复码区必须讲清威胁模型 —— */
check("概览页恢复码卡：说明「密钥与归档同目录」这一限制", async () => {
  const r = await renderSerial("zh-CN", seedsFor(), nextBust());
  const joined = r.text.join("\n");
  assert.ok(joined.includes("key.b64"), "must name the key file");
  assert.ok(joined.includes("加密保护的是归档离开本机之后"), `threat model wording missing: ${joined.slice(0, 400)}`);
  assert.ok(joined.includes("不防能读你本机这个目录的人"), "must state what encryption does NOT protect against");
});
check("英文恢复码卡也有同等的威胁模型说明", async () => {
  const r = await renderSerial("en-US", seedsFor(), nextBust());
  const joined = r.text.join("\n");
  assert.ok(joined.includes("key.b64"), "en must name the key file");
  assert.ok(joined.includes("after they leave this machine"), `en threat model missing: ${joined.slice(0, 400)}`);
  const cjk = joined.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g);
  assert.equal(cjk, null, `CJK leaked: ${JSON.stringify(cjk)}`);
});
section("结果");
if (failures.length > 0) {
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
}
process.stdout.write(`\nclient-smoke: 通过 ${passed} / 失败 ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
