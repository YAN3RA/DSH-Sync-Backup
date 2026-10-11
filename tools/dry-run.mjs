/**
 * dsh-sync-backup / tools/dry-run.mjs
 *
 * 本地 dry-run：不联网、不写任何文件，只做「收集 → 打包 → 解包 → 比对」闭环。
 *
 * 验证目标：
 *  1. 白名单收集到的文件数与总体积符合预期（259 文件 ≈ 18.54 MB）；
 *  2. 打包 + gzip 后体积合理（约 13.15 MB / 72%）；
 *  3. 解包后逐文件 SHA256 与源文件完全一致（无损往返）；
 *  4. **归档中不含任何危险路径**（.credentials.yaml / web-login / secrets …）；
 *  5. 长路径（>100 字节）能被正确拆分与还原。
 *
 * 用法：node tools/dry-run.mjs [--home <DSH_HOME>] [--full]
 *   默认只对 20 个样本文件做打包往返（快），--full 才打包全部（约 13 MB，稍慢）。
 */

import path from "node:path";
import os from "node:os";
import { gunzipSync } from "node:zlib";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";

import { collect, isForbidden, listWhitelistFiles, sha256, WHITELIST } from "../lib/collect.js";
import { buildArchive, openArchive, splitUstarPath, NAME_MAX, PREFIX_MAX } from "../lib/archive.js";

const argv = process.argv.slice(2);
const full = argv.includes("--full");
const homeIdx = argv.indexOf("--home");
const explicitHome = homeIdx !== -1 && Boolean(argv[homeIdx + 1]);
let home = explicitHome ? path.resolve(argv[homeIdx + 1]) : path.join(os.homedir(), ".dsh");

const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";
const pct = (a, b) => (b === 0 ? "0%" : ((a / b) * 100).toFixed(1) + "%");

let failures = 0;
function check(ok, label, detail = "") {
  const mark = ok ? "  ✓" : "  ✗";
  if (!ok) failures++;
  console.log(`${mark} ${label}${detail ? "  — " + detail : ""}`);
}

/**
 * 造一份确定性的合成 $DSH_HOME。
 *
 * 为什么需要它：本脚本有两条断言直接依赖 home 的**真实内容** ——
 *   [1] 「收集到文件」= entries.length > 0
 *   [3] 「确实存在需要拆分的长路径」= longPaths.length > 0
 * 开发机上 ~/.dsh 有内容所以一直绿；CI runner 上是干净机器，收集结果是 0 文件，
 * 于是两条断言必然红灯（实测：✗ 收集到文件 0 个 + ✗ 需要拆分的长路径 0 条）。
 * 这不是 CI 配置的问题 —— 让测试的通过与否取决于「跑测试那台机器碰巧装过什么」，
 * 本身就是缺陷。所以：没有显式 --home 且默认 home 收集不到东西时，回落到这份 fixture，
 * 让「零网络、零凭据、干净 runner」也能完整覆盖打包/往返/长路径拆分三条主链路。
 *
 * 路径刻意设计成真需要 USTAR prefix 拆分（>100 字节），但**每一段都 ≤100 字节**，
 * 这样既走到拆分分支，又不需要 GNU/PAX 扩展头（与 [3] 的两条容量断言一致）。
 */
async function makeFixtureHome() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsb-dryrun-fixture-"));
  const longA = `memory/${"a".repeat(80)}/${"b".repeat(30)}.md`;
  const longB = `memory/notes/${"c".repeat(90)}.md`;

  const files = new Map([
    // 白名单内的常规条目（AGENTS.md / dsh-auto-memory.json 是 file 规则）
    ["AGENTS.md", "# fixture persona\n"],
    ["dsh-auto-memory.json", '{"schemaVersion":1}\n'],
    ["memory/MEMORY.md", "# fixture memory\n" + "x".repeat(200) + "\n"],
    ["memory/DAILY.md", "# fixture daily\n" + "y".repeat(120) + "\n"],
    // 顶层 glob 规则：dsh-config-manager/sync/*.json 只收顶层
    ["dsh-config-manager/sync/targets.json", '{"kind":"fixture"}\n'],
    // 长路径样本（>100 字节，驱动 [3] 的拆分分支）
    [longA, "long-a\n"],
    [longB, "long-b\n"],
    // 危险路径：白名单外的文件**不该**被收走，用来验证结构性排除仍然成立
    [".credentials.yaml", "must-never-be-collected\n"],
  ]);

  for (const [rel, content] of files) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

let fixtureHome = null;
if (!explicitHome) {
  // 只用 listWhitelistFiles 探测：它只遍历目录、**不读文件内容**，
  // 因此这份探测在真机上几乎零成本（collect 会把 65 MB 全读进内存）。
  const probe = await listWhitelistFiles(home).catch(() => null);
  if (!probe || probe.files.length === 0) {
    fixtureHome = await makeFixtureHome();
    home = fixtureHome;
    console.log(`⚠️  默认 home 收集不到文件，改用确定性 fixture：${home}\n`);
  }
}

console.log("=== dsh-sync-backup dry-run ===");
console.log(`DSH_HOME = ${home}`);
console.log(`模式     = ${full ? "full（全量打包）" : "sample（20 文件抽样往返）"}`);
console.log(`白名单   = ${WHITELIST.length} 条规则\n`);

/* ---------- 1. 收集 ---------- */
const t0 = Date.now();
const { entries, manifest, skipped } = await collect(home);
const collectMs = Date.now() - t0;

console.log("[1] 收集");
check(entries.length > 0, "收集到文件", `${entries.length} 个 / ${manifest.totalBytes} 字节 = ${mb(manifest.totalBytes)}`);
check(entries.length === manifest.fileCount, "manifest.fileCount 与实际条目一致");
check(
  entries.every((e) => e.sha256 === sha256(e.data)),
  "每条 sha256 与内容自洽",
);
console.log(`      用时 ${collectMs} ms；跳过规则：${skipped.map((s) => `${s.path}(${s.reason})`).join(", ") || "无"}`);

/* ---------- 2. 危险路径断言 ---------- */
console.log("\n[2] 危险路径断言（凭据结构性排除）");
const dangerousHits = entries.filter((e) => isForbidden(e.path));
check(dangerousHits.length === 0, "归档清单中不含任何危险路径", dangerousHits.map((e) => e.path).join(", "));
const credHit = entries.find((e) => e.path.includes(".credentials"));
check(!credHit, "不含 .credentials.yaml");
check(!entries.some((e) => e.path.includes("web-login")), "不含 web-login/**");
check(!entries.some((e) => e.path.startsWith("profiles/")), "不含 profiles/**（1.38 GB）");
check(!entries.some((e) => e.path.startsWith("dsh-runtimes/")), "不含 dsh-runtimes/**");
check(
  !entries.some((e) => /^dsh-config-manager\/sync\/.+\//.test(e.path)),
  "sync/ 未递归（无 423 子目录快照）",
);

/* ---------- 3. 长路径拆分 ---------- */
console.log("\n[3] USTAR 长路径拆分（阻塞项 B3）");
const longPaths = entries.map((e) => e.path).filter((p) => Buffer.byteLength(p, "utf8") > NAME_MAX);
const maxLen = Math.max(...entries.map((e) => Buffer.byteLength(e.path, "utf8")));
const maxSeg = Math.max(
  ...entries.flatMap((e) => e.path.split("/").map((s) => Buffer.byteLength(s, "utf8"))),
);
console.log(`      >${NAME_MAX} 字节的路径：${longPaths.length} 条；最长路径 ${maxLen} 字节；最长单段 ${maxSeg} 字节`);
check(longPaths.length > 0, "确实存在需要拆分的长路径", `${longPaths.length} 条`);
check(maxLen <= PREFIX_MAX + 1 + NAME_MAX, "最长路径在 prefix+name 容量内");
check(maxSeg <= NAME_MAX, "无单段超过 name 容量（无需 GNU/PAX 头）");
let splitOk = 0;
for (const p of longPaths) {
  const { name, prefix } = splitUstarPath(p);
  const back = prefix ? `${prefix}/${name}` : name;
  if (back === p && Buffer.byteLength(name, "utf8") <= NAME_MAX && Buffer.byteLength(prefix, "utf8") <= PREFIX_MAX) {
    splitOk++;
  }
}
check(splitOk === longPaths.length, "全部长路径拆分后可无损还原", `${splitOk}/${longPaths.length}`);
if (longPaths.length) console.log(`      示例：${longPaths.sort((a, b) => b.length - a.length)[0]}`);

/* ---------- 4. 打包 + 解包往返 ---------- */
console.log("\n[4] 打包 → 解包 → SHA256 逐文件比对");
const sample = full ? entries : pickSample(entries, 20);
const t1 = Date.now();
const { tar, gz, rawBytes, gzBytes } = buildArchive(sample.map((e) => ({ path: e.path, data: e.data, mode: e.mode, mtimeMs: e.mtimeMs })));
const packMs = Date.now() - t1;

check(tar.length % 512 === 0, "tar 长度为 512 的整数倍", `${tar.length}`);
check(gzBytes < rawBytes || sample.reduce((n, e) => n + e.size, 0) < 1024, "gzip 有效压缩", `${mb(rawBytes)} → ${mb(gzBytes)}（${pct(gzBytes, rawBytes)}）`);
console.log(`      打包 ${packMs} ms；tar ${mb(rawBytes)}；gz ${mb(gzBytes)}；载荷 ${mb(sample.reduce((n, e) => n + e.size, 0))}`);

const t2 = Date.now();
const restored = openArchive(gz);
const unpackMs = Date.now() - t2;
check(restored.length === sample.length, "解包条目数与打包一致", `${restored.length} / ${sample.length}`);

const byPath = new Map(restored.map((r) => [r.path, r]));
let mismatch = 0;
let byteMismatch = 0;
for (const src of sample) {
  const got = byPath.get(src.path);
  if (!got) {
    mismatch++;
    continue;
  }
  if (got.data.length !== src.size) byteMismatch++;
  if (sha256(got.data) !== src.sha256) byteMismatch++;
}
check(mismatch === 0, "所有路径都被还原", `缺失 ${mismatch}`);
check(byteMismatch === 0, "所有 SHA256 与长度逐条一致", `不一致 ${byteMismatch}`);
const restoredSet = new Set(restored.map((r) => r.path));
const extra = [...restoredSet].filter((p) => !sample.some((s) => s.path === p));
check(extra.length === 0, "无多余条目", extra.join(", "));
console.log(`      解包 ${unpackMs} ms`);

/* ---------- 5. 缩放估算 ---------- */
console.log("\n[5] 全量缩放估算");
const sampledBytes = sample.reduce((n, e) => n + e.size, 0);
if (!full && sampledBytes > 0) {
  const ratio = gzBytes / sampledBytes;
  console.log(
    `      抽样压缩比 ${pct(gzBytes, sampledBytes)} → 全量 ${mb(manifest.totalBytes)} 预计 gzip 后约 ${mb(manifest.totalBytes * ratio)}`,
  );
} else {
  console.log(`      全量实际：${mb(manifest.totalBytes)} → gzip ${mb(gzBytes)}（${pct(gzBytes, manifest.totalBytes)}）`);
}

console.log("\n=== 结果 ===");
// fixture 是临时目录，跑完即删；显式 --home 时 fixtureHome 为 null，不动用户目录。
if (fixtureHome) {
  await rm(fixtureHome, { recursive: true, force: true }).catch(() => {});
}
if (failures === 0) {
  console.log("全部检查通过 ✓");
  process.exit(0);
} else {
  console.log(`${failures} 项检查失败 ✗`);
  process.exit(1);
}

/** 均匀抽样，但强制带上最长的若干条路径以覆盖长路径分支。 */
function pickSample(list, n) {
  const byLen = [...list].sort((a, b) => Buffer.byteLength(b.path, "utf8") - Buffer.byteLength(a.path, "utf8"));
  const must = byLen.slice(0, 3);
  const mustSet = new Set(must.map((e) => e.path));
  const step = Math.max(1, Math.floor(list.length / (n - must.length)));
  const out = [...must];
  for (let i = 0; i < list.length && out.length < n; i += step) {
    if (!mustSet.has(list[i].path)) out.push(list[i]);
  }
  return out;
}
