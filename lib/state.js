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
 * 原子写入状态文件（先写 .tmp 再 rename）。
 *
 * @param {string} dataDir
 * @param {object} state
 * @returns {Promise<string>} 写入的绝对路径
 */
export async function saveState(dataDir, state) {
  const file = statePath(dataDir);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.mkdir(dataDir, { recursive: true });
  const body = JSON.stringify({ ...state, schemaVersion: 1 }, null, 2);
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, file);
  return file;
}

export default { redact, loadState, saveState, statePath };
