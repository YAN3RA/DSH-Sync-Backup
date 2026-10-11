/**
 * 本地产物管理：把加密 tar.gz 落盘 + 按天数过期清理。
 *
 * ⚠️ **为什么默认敢落盘（v3）**
 *
 * 在 P1–P4 阶段本插件**从不把归档写到磁盘**（只在内存里打包后 gzip），
 * 原因很简单：磁盘上的归档是明文备份，谁都能读。
 * v3 起归档在离开内存前先过 `lib/crypto.js` 的 AES-256-GCM，
 * 所以「落盘」这件事的风险性质变了 —— 从「留一份明文履历」变成
 * 「留一份没有 key 就打不开的密文」。这才敢把默认开关打开。
 *
 * 仍然保留的边界：
 * - 目录固定在 `$DSH_HOME/<dataDir>/artifacts/`，与其它数据隔离；
 * - 文件名只含时间戳+随机 hex，可预测性低；
 * - 清理只看文件名的日期部分 + mtime，不递归、不跟随符号链接；
 * - 删除前用 `lib/collect.js` 的 `isForbidden` 再兜一次，防止路径穿越删除到别处。
 *
 * 扩展名仍是 `.tar.gz`，但**内容已不是 gzip** —— 它是
 * `MAGIC | iv | tag | AES-GCM(gzip(...))`。这样命名是为了让用户在文件管理器里
 * 一眼认出「这是我的备份」；判断要不要解密看 magic，不看扩展名。
 *
 * 零第三方依赖：只用 node:fs / node:path。
 *
 * @module dsh-sync-backup/lib/artifacts
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { isForbidden } from "./collect.js";

/** 产物目录名（在 dataDir 之下）。 */
export const ARTIFACT_SUBDIR = "artifacts";

/** 产物文件名形如 `20261010-122233-ab12cd34.tar.gz`。 */
const ARTIFACT_NAME = /^(\d{8})-(\d{6})-[0-9a-f]{8}\.tar\.gz$/;

/** 产物目录绝对路径。 */
export function artifactDir(dataDir) {
  return path.join(dataDir, ARTIFACT_SUBDIR);
}

/**
 * 把 Buffer 写成产物文件。
 *
 * @param {string} dataDir 插件数据目录（绝对路径）
 * @param {string} id      快照 id（`YYYYMMDD-HHMMSS-<hex>`）
 * @param {Buffer} gz      gzip 后的字节
 * @returns {Promise<{file: string, bytes: number}>}
 */
export async function persist(dataDir, id, gz) {
  const dir = artifactDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.tar.gz`);
  // 临时文件 + 原子 rename。
  // 直接写最终名有个安静的坏后果：进程在写盘中途被杀（或磁盘写失败）会在
  // **正确的产物文件名**下留一个截断的包，而产物列表会把它当普通 artifact
  // 列出来 —— 用户看到的是「有一份备份」，实际那份永远解不开。
  // 用随机后缀而不是 pid：同一进程内两个并发 persist 也会撞车（同 keyring 的教训）。
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmp, gz);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return { file, bytes: gz.length };
}

/** 从文件名解析出 Date；非产物文件名返回 null。 */
export function artifactDate(name) {
  const m = ARTIFACT_NAME.exec(name);
  if (m == null) return null;
  const iso = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(
    2,
    4,
  )}:${m[2].slice(4, 6)}`;
  const d = new Date(`${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 列出产物（按新的在前排序）。
 *
 * @returns {Promise<Array<{name:string, file:string, bytes:number, mtimeMs:number}>>}
 */
export async function listArtifacts(dataDir) {
  const dir = artifactDir(dataDir);
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const d of dirents) {
    if (!d.isFile()) continue;
    if (ARTIFACT_NAME.exec(d.name) == null) continue;
    const file = path.join(dir, d.name);
    try {
      const st = await fs.stat(file);
      out.push({ name: d.name, file, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // 读到一半被删就算了
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 汇总占用。
 *
 * @returns {Promise<{count:number, bytes:number, dir:string, exists:boolean}>}
 */
export async function usage(dataDir) {
  const items = await listArtifacts(dataDir);
  return {
    count: items.length,
    bytes: items.reduce((n, i) => n + i.bytes, 0),
    dir: artifactDir(dataDir),
    exists: items.length > 0,
  };
}

/**
 * **判定**哪些产物会被清理 —— 纯计算，一个文件都不删。
 *
 * 报告 5.6：destructive 操作应当在执行前先告诉用户「会删几份、释放多少空间」。
 * 判定与 prune 共用这一段代码，避免预览与实删两套逻辑漂移
 * （预览说删 2 份、实际删了 3 份，比不给预览更糟）。
 *
 * 两个独立条件，任一命中即删：
 * - 年龄超过 `keepDays`（>0 才生效）；
 * - 按时间排序后超出 `keepLast` 份的部分（>0 才生效）。
 *
 * 结构性兜底与 prune 一致：文件名必须完全可控，否则不进名单
 * （这条同时挡住 `<id>.tar.gz.tmp-<hex>` 残留）。
 *
 * @param {string} dataDir
 * @param {{keepDays?:number, keepLast?:number, now?:Date}} [opts]
 * @returns {Promise<{doomed: Array<{name:string,bytes:number}>, kept: number, bytes:number, total:number}>}
 */
export async function planPrune(dataDir, opts = {}) {
  const keepDays = Number.isFinite(opts.keepDays) ? opts.keepDays : 0;
  const keepLast = Number.isFinite(opts.keepLast) ? opts.keepLast : 0;
  const now = opts.now instanceof Date ? opts.now : new Date();

  const items = await listArtifacts(dataDir);
  if (items.length === 0) return { doomed: [], kept: 0, bytes: 0, total: 0 };

  const cutoffMs = keepDays > 0 ? now.getTime() - keepDays * 86400000 : 0;
  const hit = new Set();

  if (cutoffMs > 0) {
    for (const it of items) {
      const d = artifactDate(it.name) ?? new Date(it.mtimeMs);
      if (d.getTime() < cutoffMs) hit.add(it.name);
    }
  }
  if (keepLast > 0) {
    for (const it of items.slice(keepLast)) hit.add(it.name);
  }

  const doomed = [];
  for (const it of items) {
    if (!hit.has(it.name)) continue;
    // 与 prune 同一道兜底：文件名不可控就宁可不删（也就不能预览为「将删」）
    if (ARTIFACT_NAME.exec(it.name) == null) continue;
    if (isForbidden(`${ARTIFACT_SUBDIR}/${it.name}`) != null) continue;
    doomed.push({ name: it.name, bytes: it.bytes });
  }
  doomed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    doomed,
    kept: items.length - doomed.length,
    bytes: doomed.reduce((n, d) => n + d.bytes, 0),
    total: items.length,
  };
}

/**
 * 清理过期的本地产物。
 *
 * 判定逻辑见 `planPrune`（两者共用，避免预览与实删漂移）；这里只负责**执行删除**。
 *
 * @param {string} dataDir
 * @param {{keepDays?:number, keepLast?:number, now?:Date}} [opts]
 * @returns {Promise<{removed: string[], kept: number, bytesFreed: number}>}
 */
export async function prune(dataDir, opts = {}) {
  const items = await listArtifacts(dataDir);
  if (items.length === 0) return { removed: [], kept: 0, bytesFreed: 0 };

  const plan = await planPrune(dataDir, opts);

  const removed = [];
  let bytesFreed = 0;
  const dir = artifactDir(dataDir);
  for (const entry of plan.doomed) {
    const name = entry.name;
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      await fs.unlink(file);
      bytesFreed += st.size;
      removed.push(name);
    } catch {
      // 并发删除或权限问题：跳过，不重试
    }
  }
  // kept 的口径是「**实际**删完后还剩几份」：某些文件可能因并发删除/权限失败被跳过，
  // 那时它仍在磁盘上，计划值（plan.kept）会低估剩余份数。
  return { removed, kept: items.length - removed.length, bytesFreed };
}

export default { ARTIFACT_SUBDIR, artifactDir, artifactDate, listArtifacts, persist, planPrune, prune, usage };
