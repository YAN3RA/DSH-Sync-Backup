/**
 * dsh-sync-backup / lib/state.js
 *
 * 状态文件读写 + 日志脱敏。零第三方依赖。
 *
 * 状态文件位置：`$DSH_HOME/dsh-sync-backup/state.json`
 * 与现有目录（config-manager / memory / skills …）完全隔离。
 *
 * @module dsh-sync-backup/lib/state
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** 需要脱敏的模式：口令 / token / 授权头。 */
const SECRET_PATTERNS = [
  [/Basic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [REDACTED]"],
  [/(password|passwd|token|secret|authorization|api[_-]?key)\s*[:=]\s*["']?[^\s"',}]{4,}/gi, "$1=[REDACTED]"],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED-GITHUB-TOKEN]"],
];

/**
 * 对任意文本做脱敏，用于错误消息与日志。
 *
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  let out = String(text ?? "");
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

/** 状态文件绝对路径。 */
export function statePath(dataDir) {
  return path.join(dataDir, "state.json");
}

/**
 * 读取状态文件；不存在或损坏时返回初始状态（不抛错）。
 *
 * @param {string} dataDir
 * @returns {Promise<object>}
 */
export async function loadState(dataDir) {
  const file = statePath(dataDir);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 同一个 dataDir 上的 state 写入队列。
 *
 * 原子 rename 只保证「不会读到半个文件」，**挡不住丢更新**：两个调用各自
 * `load → 改 → save` 时，后写的会把前者的改动整个覆盖掉（典型的 read-modify-write
 * 竞争）。run lock 已经覆盖了常规备份路径，但状态页刷新、维护操作等仍可能并发
 * 触碰同一个文件，所以在写入这一层再串一次。
 */
const writeChains = new Map();

/**
 * 原子写入状态文件（先写随机 tmp 再 rename），并对同一文件串行化。
 *
 * tmp 名带随机后缀而不是只用 pid：同一进程内两个并发写会撞同一个文件名，
 * 先完成的 rename 走它、后一个再 rename 就是 ENOENT（keyring.js 已因同类
 * 问题加过 inflight 去重，这里的教训一样）。
 *
 * @param {string} dataDir
 * @param {object} state
 * @returns {Promise<string>} 写入的绝对路径
 */
export async function saveState(dataDir, state) {
  const file = statePath(dataDir);
  const prev = writeChains.get(file) ?? Promise.resolve();
  const task = prev
    .catch(() => {})
    .then(async () => {
      const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      await fs.mkdir(dataDir, { recursive: true });
      const body = JSON.stringify({ ...state, schemaVersion: 1 }, null, 2);
      await fs.writeFile(tmp, body, "utf8");
      await fs.rename(tmp, file);
      return file;
    });
  writeChains.set(file, task);
  // 队列尾部任务落地后清掉自己，避免 Map 无界增长；清理时确认仍是自己那一格。
  void task
    .catch(() => {})
    .then(() => {
      if (writeChains.get(file) === task) writeChains.delete(file);
    });
  return await task;
}

export default { redact, loadState, saveState, statePath };
