/**
 * 用户配置读写（v3）。零第三方依赖。
 *
 * ## 为什么要有这个文件
 *
 * 在此之前，改任何设置都要手改 `cordis.patch.yml`：找到对应的 bundle 行、
 * 改 YAML 缩进、重启。对一个只想「备份一下记忆」的人来说，这是劝退门槛。
 *
 * 所以配置改写到**本插件自己的** `$DSH_HOME/dsh-sync-backup/config.json`：
 *
 * - **优先级高于 patch**：用户在这儿改了就以这儿为准；
 * - **不碰 patch 本身**：永远不会有「重写 YAML 把注释冲掉」这类事故；
 * - **删文件即回到默认**：出问题只需 `rm config.json`，不需要重装插件。
 *
 * ## 为什么不用 patch 做主存储
 *
 * `cordis.patch.yml` 是 bundle 的**安装清单**，由 loader 读取；把它同时当作
 * 运行时可变配置，等于让每次界面点击都去改写一份带结构的文件 —— 一旦格式
 * 漂移，插件启动时会整体失败。两个用途分开，是这里唯一稳的做法。
 *
 * @module dsh-sync-backup/lib/user-config
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export const CONFIG_SCHEMA_VERSION = 1;

/** 配置文件绝对路径。 */
export function configPath(dataDir) {
  return path.join(dataDir, "config.json");
}

/**
 * 读取用户配置。不存在 / 损坏 / 非对象一律返回 `{}` —— **绝不抛错**。
 *
 * 理由：配置读失败就让插件起不来，是把一个小故障放大成整机故障。
 * 读不到就当「全部用默认值」，用户在界面上会看到 patch 里的默认值，
 * 重新改一次即可覆盖。
 */
export async function loadUserConfig(dataDir) {
  const file = configPath(dataDir);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const { schemaVersion: _v, ...rest } = parsed;
    return rest;
  } catch {
    return {};
  }
}

/**
 * 原子写入用户配置（tmp + rename）。
 *
 * 写入前**先把现有文件备份成 `config.json.bak`**。理由：这是用户唯一需要
 * 手动维护的文件，一次写坏就得从头配；备份一个 1KB 的文件成本为零。
 *
 * @param {string} dataDir
 * @param {object} patch 要合并进配置的键值（浅合并）
 * @returns {Promise<{file: string, config: object}>}
 */
export async function saveUserConfig(dataDir, patch) {
  const file = configPath(dataDir);
  await fs.mkdir(dataDir, { recursive: true });

  const prev = await loadUserConfig(dataDir);
  try {
    await fs.copyFile(file, `${file}.bak`);
  } catch {
    // 首次写入没有旧文件，忽略
  }

  const config = { ...prev, ...patch };
  const tmp = `${file}.tmp-${process.pid}`;
  const body = JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, ...config }, null, 2);
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, file);
  return { file, config };
}

/**
 * 把用户配置合并进 patch 提供的默认值。
 *
 * 只有 **`null` / 缺失** 的键才回退到默认值 —— 用户显式写了 `false`、
 * `0`、`""` 就是写了，不能被默认值盖回去。这是 interfaces 里最容易出错的
 * 一点：用 `??` 是对的，用 `||` 会让用户永远无法关掉某个开关。
 *
 * @param {object} defaults patch 解析后的配置
 * @param {object} user 用户配置
 * @returns {object}
 */
export function mergeConfig(defaults, user) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(user ?? {})) {
    out[key] = value;
  }
  return out;
}

/**
 * 只保留允许用户在界面上改的键。
 *
 * 白名单而非黑名单：新增配置时若不显式开放，界面就改不到它。
 * 宁可漏开一个，也好过让用户从界面改出一个我们没考虑过的状态。
 */
export const GUI_EDITABLE_KEYS = Object.freeze([
  "enabled",
  "keepLast",
  "localKeepDays",
  "intervalHours",
  "remoteIntervalHours",
  "restoreCheck",
  "selectedPaths",
  "includeSessions",
  "includeSemantic",
  "webdavEnabled",
  "webdavUrl",
  "webdavUsername",
  "webdavPath",
  "githubEnabled",
  "githubRepo",
  "githubPath",
]);

/**
 * 过滤出一个只含可界面编辑键的对象。
 * @returns {{accepted: object, rejected: string[]}}
 */
export function pickEditable(input) {
  const accepted = {};
  const rejected = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    if (GUI_EDITABLE_KEYS.includes(key)) accepted[key] = value;
    else rejected.push(key);
  }
  return { accepted, rejected };
}

/**
 * 每个可编辑键的**形状守卫**。
 *
 * 界面传来的东西不能盲信：一个 `keepLast: "七天"` 会让下次 prune 的行为无法预测，
 * 而这类错误写进 config.json 之后**不会自己消失** —— 插件每次启动都会读它。
 * 所以在落盘之前逐个校验，形状不对就在这里退回去，宁可不改也不要改坏。
 */
const EDITABLE_TYPES = Object.freeze({
  enabled: "boolean",
  keepLast: "number",
  localKeepDays: "number",
  intervalHours: "number",
  remoteIntervalHours: "number",
  restoreCheck: "boolean",
  selectedPaths: "array",
  includeSessions: "boolean",
  includeSemantic: "boolean",
  webdavEnabled: "boolean",
  webdavUrl: "string",
  webdavUsername: "string",
  webdavPath: "string",
  githubEnabled: "boolean",
  githubRepo: "string",
  githubPath: "string",
});

/**
 * 白名单 + 形状校验 + 取值约束。落盘前的统一入口。
 *
 * @param {object} input GUI 传来的原始对象
 * @param {object} [opts]
 * @param {Set<string>} [opts.knownPathIds] CATALOG 里合法的条目 id；给空则跳过 selectedPaths 的内容校验
 * @returns {{accepted: object, rejected: string[], problems: string[]}}
 */
export function sanitizeEditable(input, opts) {
  const { accepted, rejected } = pickEditable(input);
  const problems = [];
  const out = {};

  for (const [key, value] of Object.entries(accepted)) {
    const want = EDITABLE_TYPES[key];
    if (want === "boolean" && typeof value !== "boolean") {
      problems.push(`${key} 需要 true / false，收到 ${typeof value}`);
      continue;
    }
    if (want === "number" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      problems.push(`${key} 需要非负数字，收到 ${JSON.stringify(value)}`);
      continue;
    }
    if (want === "string" && typeof value !== "string") {
      problems.push(`${key} 需要文本，收到 ${typeof value}`);
      continue;
    }
    if (want === "array") {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        problems.push(`${key} 需要字符串数组，收到 ${JSON.stringify(value)}`);
        continue;
      }
      const known = opts?.knownPathIds;
      if (known instanceof Set && known.size > 0) {
        const bad = value.filter((v) => !known.has(v));
        if (bad.length > 0) {
          problems.push(`${key} 含未知条目 id：${bad.join(", ")}`);
          continue;
        }
      }
      // 去重 + 稳定排序：同一个集合的两种写法不该在 config.json 里产生两份 diff
      out[key] = [...new Set(value)].sort();
      continue;
    }
    out[key] = value;
  }

  return { accepted: out, rejected, problems };
}

export default {
  configPath,
  loadUserConfig,
  saveUserConfig,
  mergeConfig,
  pickEditable,
  sanitizeEditable,
  GUI_EDITABLE_KEYS,
};
