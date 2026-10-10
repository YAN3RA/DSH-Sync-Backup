/**
 * dsh-sync-backup / lib/collect.js
 *
 * 白名单收集器：只收集显式列出的路径，**绝不使用黑名单**。
 * 任何不在白名单内的路径都不可能进入归档——这是"凭据永不外传"的结构性保证。
 *
 * 零第三方依赖：只用 node: 内置模块。
 *
 * @module dsh-sync-backup/lib/collect
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * 白名单定义（相对 $DSH_HOME）。
 *
 * - `kind: "file"`  —— 单个文件，缺失即跳过（不报错）
 * - `kind: "dir"`   —— 递归收集目录下全部普通文件
 * - `kind: "glob"`  —— 只收集目录**顶层**匹配 `pattern` 的普通文件（不递归）
 *
 * ⚠️ `dsh-config-manager/sync/` 必须是 glob 而非 dir：该目录递归下有
 * 423 个子目录 / 510 文件 / 13.2 MB 历史快照，写成递归会瞬间把载荷撑大 3 倍。
 */
/**
 * 备份条目目录（CATALOG）。
 *
 * 每条是「用户可勾选的一个备份项」，`id` 供 GUI 勾选与持久化使用，
 * `rules` 沿用上述白名单规则结构（file / dir / glob）。
 *
 * 三个字段是**给人看的**，不是给代码看的：
 * - `intro` / `introEn`：同一句话的中文与英文版本。面板按界面语言选一边渲染 ——
 *   别指望在浏览器里做机器翻译，一句话的介绍译错了比不译更糟；
 * - `risk`：跨版本 / 换机器恢复回来的风险（low / medium / high）。
 *
 * risk 的判定口径（写死在此，避免每次都由我即兴判）：
 * - low    —— 内容格式由 DSH 自己的 schema 定义或纯 Markdown/文本，跨版本稳定；
 * - medium —— 内容格式由**别的插件**定义，插件改版可能读不懂旧数据；
 * - high   —— 二进制/分片/带机器相关路径，只有相同版本 + 相同环境才谈得上恢复。
 *
 * `defaultOn` 为 false 的项（如 profiles）默认不选：它们体积达 GB 级
 * 且能在任何机器上重装，勾选的收益远小于代价。
 */
export const CATALOG = Object.freeze([
  {
    id: "persona",
    intro: "全局人格与行为指令文件，每会话自动注入。纯 Markdown，任何版本都能直接读。",
    introEn: "Global persona and behaviour directives, injected into every session. Plain Markdown — readable by any version.",
    risk: "low",
    defaultOn: true,
    rules: [{ path: "AGENTS.md", kind: "file" }],
  },
  {
    id: "memory-config",
    intro: "记忆系统的配置（记忆根、注入预算、容量上限等），决定记忆如何写入与 recall。",
    introEn: "Memory-system settings (root, injection budget, capacity caps) — these decide how notes get written and recalled.",
    risk: "low",
    defaultOn: true,
    rules: [{ path: "dsh-auto-memory.json", kind: "file" }],
  },
  {
    id: "memory",
    intro: "长期记忆、每日工作日志、语义索引与交接账本 —— 跨设备接续人格与上下文的核心。",
    introEn: "Long-term notes, daily logs, semantic indexes and handoff ledgers — the core of carrying context across machines.",
    risk: "low",
    defaultOn: true,
    rules: [{ path: "memory/", kind: "dir", maxDepth: Infinity }],
  },
  {
    id: "skills",
    intro: "技能的 SKILL.md 与随附脚本，均为纯文本；换机器拷回来即可用。",
    introEn: "Skill instructions and their bundled scripts, all plain text — copy them to another machine and they work.",
    risk: "low",
    defaultOn: true,
    rules: [{ path: "skills/", kind: "dir", maxDepth: Infinity }],
  },
  {
    id: "task-board",
    intro: "任务板账本与调度器状态（任务在哪个看板列、上次跑的结果与下一次计划时间）。",
    introEn: "Task-board ledger and scheduler state (which column a task sits in, its last run outcome and next planned time).",
    risk: "medium",
    defaultOn: true,
    rules: [{ path: "task-board/", kind: "dir", maxDepth: 2 }],
  },
  {
    id: "sync-config",
    intro: "config-manager 的同步目标配置；只收顶层 json（递归会带进上万个历史快照目录）。",
    introEn: "config-manager's sync target configuration; top-level json only (recursing would drag in thousands of snapshot directories).",
    risk: "medium",
    defaultOn: true,
    rules: [{ path: "dsh-config-manager/sync/", kind: "glob", pattern: /^[^\\/]+\.json$/ }],
  },
  {
    id: "storages",
    intro: "各插件自己的持久化数据。格式由插件作者定义，不是 DSH 定的，插件改版可能读不懂。",
    introEn: "Each plugin's own persisted data. The format belongs to the plugin author, not to DSH — a major release may not read it back.",
    risk: "medium",
    defaultOn: true,
    rules: [{ path: "storages/", kind: "dir", maxDepth: 2 }],
  },
  {
    id: "sessions",
    intro: "会话记录（zstd 分片追加式）。体积通常是载荷里最大的一块，恢复能力取决于写入时的分片格式。",
    introEn: "Session transcripts (zstd, append-only shards). Usually the largest slice of a payload; whether it can be restored depends on the shard format at write time.",
    risk: "high",
    defaultOn: true,
    rules: [{ path: "sessions/", kind: "dir", maxDepth: Infinity }],
  },
  {
    id: "profiles",
    intro: "插件本体的浅层文件（约 2 层；**不含 node_modules**，依赖树可在任何机器上重装）。体积仍可能很大，且能被重装 —— 默认不选。",
    introEn: "Shallow plugin files (about two levels; **node_modules excluded** — dependency trees reinstall anywhere). Still bulky and reinstallable — off by default.",
    risk: "high",
    defaultOn: false,
    rules: [{ path: "profiles/", kind: "dir", maxDepth: 2 }],
  },
]);

/**
 * 默认白名单 = 所有 defaultOn 条目的规则展开。
 * 与 v1 的 WHITELIST 等价（v1 不含 profiles），保证不改配置时行为不变。
 */
export const WHITELIST = Object.freeze(
  CATALOG.filter((e) => e.defaultOn !== false).flatMap((e) => e.rules),
);

/** 按 id 取条目。 */
export function catalogEntry(id) {
  return CATALOG.find((e) => e.id === id);
}

/**
 * 把「勾选了哪些 id」展开成白名单规则。
 *
 * @param {string[]|null|undefined} selected 勾选的 id 列表；null/undefined/空数组都取默认集合
 * @returns {Array} 规则数组
 */
export function resolveWhitelist(selected) {
  if (!Array.isArray(selected) || selected.length === 0) return WHITELIST;
  const picked = CATALOG.filter((e) => selected.includes(e.id));
  if (picked.length === 0) return [];
  return picked.flatMap((e) => e.rules);
}

/**
 * 危险路径（自检用）：一旦命中立即中止本次备份。
 * 这些是"绝不该出现在归档里"的东西，属结构性兜底——即使白名单写错也要拦住。
 */
export const FORBIDDEN_SEGMENTS = Object.freeze([
  ".credentials.yaml",
  ".plugin-manager",
  "web-login",
  "secrets",
  "credentialsStatus",
]);

/** 递归跳过目录名（降低无效遍历与误收风险）。 */
const SKIP_DIRS = new Set([".git", "node_modules", ".cache", "tmp"]);

/** 计算 Buffer 的 SHA256 hex。 */
export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 判断相对路径是否命中危险段。 */
export function isForbidden(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (FORBIDDEN_SEGMENTS.includes(seg)) return seg;
  }
  if (/^\.credentials/.test(path.posix.basename(normalized))) {
    return path.posix.basename(normalized);
  }
  return null;
}

/**
 * 递归列出目录下的普通文件（相对 root 的 posix 路径）。
 * 符号链接一律跳过（避免把归档膨胀成任意路径读取）。
 */
async function walkDir(root, relDir, maxDepth, out, depth = 0) {
  const absDir = path.join(root, relDir);
  let dirents;
  try {
    dirents = await fs.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EPERM") return;
    throw err;
  }
  for (const d of dirents) {
    const rel = relDir ? `${relDir}/${d.name}` : d.name;
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name)) continue;
      if (depth + 1 > maxDepth) continue;
      await walkDir(root, rel, maxDepth, out, depth + 1);
    } else if (d.isFile()) {
      out.push(rel);
    }
  }
}

/** 只列目录**顶层**匹配 pattern 的文件。 */
async function listTopLevel(dir, relDir, pattern, out) {
  let dirents;
  try {
    dirents = await fs.readdir(path.join(dir, relDir), { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EPERM") return;
    throw err;
  }
  for (const d of dirents) {
    if (!d.isFile()) continue;
    if (!pattern.test(d.name)) continue;
    out.push(relDir ? `${relDir}${d.name}` : d.name);
  }
}

/**
 * 按白名单收集文件清单。
 *
 * @param {string} home  $DSH_HOME 绝对路径
 * @param {object} [opts]
 * @param {Array}  [opts.whitelist]  覆盖默认白名单（测试用）
 * @returns {Promise<{files: string[], skipped: Array<{path:string, reason:string}>}>}
 */
export async function listWhitelistFiles(home, opts = {}) {
  const whitelist = opts.whitelist ?? WHITELIST;
  const files = [];
  const skipped = [];

  for (const rule of whitelist) {
    const clean = rule.path.replace(/\/$/, "");
    if (rule.kind === "file") {
      const abs = path.join(home, clean);
      // ⚠️ 这里必须用 lstat 而不是 stat：stat 会**跟随符号链接**，于是
      // 「把 AGENTS.md 换成一个指向 $DSH_HOME 之外的链接」就能把白名单外的
      // 内容塞进归档。目录分支靠 Dirent.isSymbolicLink() 已经躲开了这一点，
      // 单文件分支早先漏了 —— 而 file 恰恰是白名单的核心语义之一。
      let st;
      try {
        st = await fs.lstat(abs);
      } catch {
        skipped.push({ path: clean, reason: "missing" });
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push({ path: clean, reason: "symbolic-link" });
        continue;
      }
      if (!st.isFile()) {
        skipped.push({ path: clean, reason: "not-a-file" });
        continue;
      }
      // 真实路径复核：即使 lstat 说它现在不是链接，也确认解析结果仍在 home 内。
      // 这挡的是「枚举时是普通文件、读取时已被换成链接」的 TOCTOU 竞态。
      try {
        const real = await fs.realpath(abs);
        const realRoot = await fs.realpath(home);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          skipped.push({ path: clean, reason: "outside-root" });
          continue;
        }
      } catch {
        skipped.push({ path: clean, reason: "unresolvable" });
        continue;
      }
      files.push(clean);
      continue;
    }
    const before = files.length;
    if (rule.kind === "dir") {
      await walkDir(home, clean, rule.maxDepth ?? Infinity, files);
    } else if (rule.kind === "glob") {
      await listTopLevel(home, clean ? `${clean}/` : "", rule.pattern, files);
    }
    if (files.length === before) skipped.push({ path: clean, reason: "empty-or-missing" });
  }

  // 去重 + 排序（保证同一输入产出同一清单，便于比对）
  const unique = [...new Set(files)].sort();

  // 结构性自检：白名单产出里出现危险路径立即失败
  for (const rel of unique) {
    const hit = isForbidden(rel);
    if (hit) {
      throw new Error(
        `collect: 白名单产出命中危险路径 "${rel}"（危险段 "${hit}"）—— 这是结构性错误，拒绝继续`,
      );
    }
  }
  return { files: unique, skipped };
}

/**
 * 读取文件内容并生成清单条目。
 *
 * @param {string} home
 * @param {string[]} relPaths
 * @returns {Promise<Array<{path:string,size:number,mtimeMs:number,sha256:string,data:Buffer}>>}
 */
export async function readEntries(home, relPaths) {
  const entries = [];
  const realRoot = await fs.realpath(home).catch(() => path.resolve(home));
  for (const rel of relPaths) {
    const abs = path.join(home, rel);
    let st;
    try {
      // lstat 而非 stat：收集与读取之间若有人把路径换成了符号链接，
      // 这里必须再次拒绝，而不是顺着链接读走白名单外的文件。
      st = await fs.lstat(abs);
    } catch (err) {
      if (err.code === "ENOENT") continue; // 收集与读取之间的正常竞态
      throw err;
    }
    if (st.isSymbolicLink()) continue;
    if (!st.isFile()) continue;
    // ⚠️ 只 lstat 最后一段是不够的：`sub/link/f.txt` 的最后一段是普通文件，
    // 但中间那段 `link` 可能是指向 home 之外的目录链接（junction 在 lstat 下
    // 甚至不算 symbolicLink）。所以必须比较**真实解析后的路径**是否仍在 home 内。
    // 这一步顺带覆盖了「枚举与读取之间被换掉」的 TOCTOU 窗口。
    let real;
    try {
      real = await fs.realpath(abs);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      continue; // 真实落点越界，拒绝读取
    }
    const data = await fs.readFile(real);
    entries.push({
      path: rel,
      size: data.length,
      mtimeMs: Math.floor(st.mtimeMs),
      mode: st.mode & 0o777,
      sha256: sha256(data),
      data,
    });
  }
  return entries;
}

/**
 * 收集 + 读取一步到位。
 *
 * @returns {Promise<{entries:Array, manifest:object, skipped:Array}>}
 */
export async function collect(home, opts = {}) {
  const { files, skipped } = await listWhitelistFiles(home, opts);
  const entries = await readEntries(home, files);

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRoot: home,
    fileCount: entries.length,
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
    files: entries.map((e) => ({
      path: e.path,
      size: e.size,
      sha256: e.sha256,
      mtimeMs: e.mtimeMs,
    })),
  };
  return { entries, manifest, skipped };
}

export default { WHITELIST, FORBIDDEN_SEGMENTS, collect, listWhitelistFiles, readEntries, sha256, isForbidden };
