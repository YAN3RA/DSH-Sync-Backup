/**
 * scheduler-plan.mjs — 只读探针：用**真实的** cordis.patch.yml 配置与真实的 DSH_HOME，
 * 驱动 BackupScheduler 跑一遍「假时钟 + 假计时器 + 打桩 runOnce」，打印它会如何排期。
 *
 * 该脚本**零写入**：runOnce 被打桩，不收集、不打包、不联网、不写 state.json。
 * 用途：作为 P4 的现场证据，证明定时器接线在真实配置下成立。
 *
 * 用法：node tools/scheduler-plan.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackupScheduler, nextRunDelayMs, shouldTriggerStartupRun } from "../lib/scheduler.js";

const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const PATCH = path.join(import.meta.dirname, "..", "cordis.patch.yml");

/** 从 cordis.patch.yml 的 config: 块里读标量（够用的最简解析）。 */
function readPatchConfig(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  let inConfig = false;
  let configIndent = 0;
  let keyIndent = 0;
  for (const line of lines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (!inConfig) {
      if (/^config\s*:\s*$/.test(line.trim())) {
        inConfig = true;
        configIndent = indent;
      }
      continue;
    }
    if (indent <= configIndent) break;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    if (keyIndent === 0) keyIndent = indent;
    if (indent !== keyIndent) continue;
    let v = m[2].trim();
    if (v === "") continue; // 嵌套块（本文件里没有）
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (v === "true") out[m[1]] = true;
    else if (v === "false") out[m[1]] = false;
    else if (/^-?\d+(\.\d+)?$/.test(v)) out[m[1]] = Number(v);
    else out[m[1]] = v;
  }
  return out;
}

const raw = fs.readFileSync(PATCH, "utf8");
const cfg = readPatchConfig(raw);

console.log("=== 真实配置（cordis.patch.yml 的 config 段）===");
console.log("  文件:", PATCH, `(${raw.length} 字节)`);
for (const k of [
  "enabled",
  "schedulerEnabled",
  "uploadOnSchedule",
  "startupRunOnBoot",
  "intervalHours",
  "startupMinIntervalMs",
  "maxBackoffHours",
  "dryRun",
  "keepLast",
  "githubRepo",
  "webdavEnabled",
]) {
  console.log(`  ${k} = ${JSON.stringify(cfg[k])}`);
}

console.log("\n=== 真实状态文件 ===");
const statePath = path.join(HOME, "dsh-sync-backup", "state.json");
console.log("  路径:", statePath);
console.log("  存在:", fs.existsSync(statePath));
let state = {};
if (fs.existsSync(statePath)) {
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    state = {};
  }
}
console.log("  lastRunAt:", state.lastRunAt ?? "(无)");
console.log("  failures :", state.failures ?? 0);

const now = new Date();

console.log("\n=== 定时器接线（假计时器 + 打桩 runOnce，零写入）===");
const calls = [];
let fired = 0;
const scheduler = new BackupScheduler({
  getConfig: async () => ({
    enabled: cfg.enabled !== false,
    intervalHours: cfg.intervalHours,
    startupMinIntervalMs: cfg.startupMinIntervalMs,
    maxBackoffHours: cfg.maxBackoffHours,
    dryRun: cfg.dryRun,
    schedulerEnabled: cfg.schedulerEnabled,
    uploadOnSchedule: cfg.uploadOnSchedule,
    startupRunOnBoot: cfg.startupRunOnBoot,
  }),
  getState: async () => state,
  runOnce: async (opts) => {
    calls.push({ at: new Date().toISOString(), upload: opts?.upload === true, reason: opts?.reason });
  },
  now: () => new Date(),
  setTimer: (fn, ms) => {
    fired += 1;
    return { fn, ms, id: fired };
  },
  clearTimer: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {} },
  // 注意：onSchedule 收到的是 {nextRunAt, delayMs, upload} 对象，不是 Date。
  onSchedule: (plan) =>
    calls.push({
      scheduledAt: plan.nextRunAt.toISOString(),
      delayHours: Number((plan.delayMs / 3600000).toFixed(2)),
      upload: plan.upload,
    }),
});

scheduler.start();
await new Promise((r) => setTimeout(r, 50));

const tickCalls = calls.filter((c) => c.at);
console.log("  start() 后 →");
for (const c of calls) {
  if (c.scheduledAt)
    console.log(`    排期回调: 下次运行 ${c.scheduledAt}（${c.delayHours} h 后，upload=${c.upload}）`);
  else console.log(`    runOnce 被调用: upload=${c.upload} reason=${c.reason}`);
}
console.log(`  nextRunAt: ${scheduler.nextRunAt ? scheduler.nextRunAt.toISOString() : "未排期"}`);
scheduler.stop();
console.log(`  stop() 后 nextRunAt: ${scheduler.nextRunAt ? scheduler.nextRunAt.toISOString() : "未排期"}`);

console.log("\n=== 纯函数口径 ===");
const plan = nextRunDelayMs({
  now,
  lastRunAt: state.lastRunAt,
  intervalHours: cfg.intervalHours,
  failures: state.failures ?? 0,
  maxBackoffHours: cfg.maxBackoffHours,
});
console.log(`  nextRunDelayMs     = ${plan} ms (${(plan / 3600000).toFixed(2)} h)`);
const startup = shouldTriggerStartupRun({
  lastRunAt: state.lastRunAt,
  now,
  startupMinIntervalMs: cfg.startupMinIntervalMs,
});
console.log(`  shouldTriggerStartupRun = ${startup}`);

console.log("\n=== 判定 ===");
console.log(`  定时器接线: ${tickCalls.length > 0 ? "✓ 真实配置下启动触发已发生" : "（无启动触发）"}`);
const uploadAllowed = cfg.uploadOnSchedule === true && cfg.dryRun !== true;
console.log(`  定时上传闸门: ${uploadAllowed ? "⚠️ 开启（会出网）" : "✓ 关闭（定时只做本地打包，零网络）"}`);
console.log(`  桩 runOnce 是否收到 upload=true: ${calls.some((c) => c.upload) ? "是" : "否 ✓"}`);
