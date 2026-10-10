#!/usr/bin/env node
/**
 * set-webdav-password.mjs — 把 WebDAV 专用密码写入本插件自己的凭据槽位。
 *
 * 凭据槽位（DSH 官方凭据层，见 README「凭据槽位」一节）：
 *   文件   $DSH_HOME/.credentials.yaml        （缺省 DSH_HOME = ~/.dsh）
 *   层级   refs: 块，键名 = 环境变量名
 *   槽位   DSH_SYNC_BACKUP_WEBDAV_PASSWORD
 *
 * 为什么要有这个脚本（v2 需求③）：
 *   早期版本在没有本插件槽位时**回退**读 config-manager 的
 *   `DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD`。那条回退已经删除了 ——
 *   借别人的专用密码意味着本插件的可用性绑在另一个插件的配置上，对方改密码
 *   或卸载时，本插件会以很难归因的方式失败。代价是用户要在本插件里录一次。
 *
 * 口径（与 set-github-token.mjs 完全一致）：
 *   - 口令**只**经环境变量或本进程的隐藏输入进入，绝不作为命令行参数
 *     （命令行参数会进 shell history 与进程表）。
 *   - 口令**绝不**写进 stdout / stderr / 日志 / 本脚本 / cordis.patch.yml。
 *   - 写盘前先备份原文件；写入用「临时文件 + rename」原子替换。
 *   - 只改 refs: 块里的目标键，文件其余内容（records、其他 refs、注释）原样保留。
 *   - 依赖：仅 Node 内置模块（插件目录没有 node_modules）。
 *
 * 用法：
 *   node tools/set-webdav-password.mjs --check
 *       只读：报告槽位是否已配置（不显示值）。
 *   node tools/set-webdav-password.mjs --from-env
 *       从 $DSH_SYNC_BACKUP_WEBDAV_PASSWORD 读取并写入。
 *   node tools/set-webdav-password.mjs --from-env MY_VAR
 *       从指定环境变量读取。
 *   node tools/set-webdav-password.mjs
 *       交互式隐藏输入（终端不回显）。这是推荐的日常方式。
 *   node tools/set-webdav-password.mjs --verify
 *       写入后顺带对目标地址发一个 PROPFIND（Depth:1）验证口令可用。
 *       目标来自 cordis.patch.yml 的 webdavUrl / webdavUsername，
 *       缺一则在环境变量 WEBDAV_URL / WEBDAV_USERNAME 里找。
 *   node tools/set-webdav-password.mjs --remove
 *       删除该槽位（同样先备份）。
 *   node tools/set-webdav-password.mjs --dry-run
 *       演练：打印将要发生的行级变更（值一律掩码），不落盘。
 *
 * 退出码：0 成功 / 1 用法或校验错误 / 2 环境问题（家目录或文件不可写）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import https from "node:https";
import http from "node:http";

/** 环境变量名（DSH 凭据 refs 层的键）。 */
const SLOT = "DSH_SYNC_BACKUP_WEBDAV_PASSWORD";

/**
 * WebDAV 专用密码的字符集与长度粗校验。
 * 坚果云的应用专用密码是 16 位字母数字；这里放宽到 4–255 个可见字符，
 * 以适应其它网盘（可能带 - _ . 等符号）。
 */
const VALUE_RE = /^[\x21-\x7e]{4,255}$/;

/* ------------------------------ 小工具 ------------------------------ */

function die(msg, code = 1) {
  process.stderr.write(`错误：${msg}\n`);
  process.exit(code);
}

function info(msg) {
  process.stdout.write(`${msg}\n`);
}

/** 永不回显口令：只给掩码与长度。 */
function mask(value) {
  if (typeof value !== "string" || value.length === 0) return "(空)";
  const keep = Math.max(1, Math.min(3, Math.floor(value.length / 4)));
  return `${value.slice(0, keep)}${"*".repeat(Math.min(12, Math.max(0, value.length - keep)))}（长度 ${value.length}）`;
}

function describe(value) {
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  const kinds = [hasLower, hasUpper, hasDigit].filter(Boolean).length;
  const shape = kinds >= 2 ? "混合字符" : hasDigit ? "纯数字" : "纯字母";
  return `${shape}，长度 ${value.length}`;
}

function resolveHome() {
  const envHome = process.env.DSH_HOME;
  if (typeof envHome === "string" && envHome.trim() !== "") return path.resolve(envHome.trim());
  return path.join(os.homedir(), ".dsh");
}

/* --------------------------- YAML 行级读写 --------------------------- */

/**
 * 极简 YAML 解析：只认 `refs:` 块内 `KEY: value` 的标量行。
 * 与 lib/creds.js 的 readRefFromYaml 同口径（顶层扁平布局也认，refs 块优先）。
 */
function readRef(text, ref) {
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  let refsIndent = 0;
  let found;

  for (const line of lines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;

    if (indent === 0) {
      inRefs = m[1] === "refs";
      refsIndent = 0;
      // 顶层扁平布局：`REF: value`
      if (m[1] === ref && m[2] !== "") found = parseScalar(m[2]);
      continue;
    }

    if (inRefs) {
      if (refsIndent === 0) refsIndent = indent;
      if (indent < refsIndent) {
        inRefs = false;
        continue;
      }
      if (indent === refsIndent && m[1] === ref) found = parseScalar(m[2]);
    }
  }
  return found;
}

function parseScalar(raw) {
  let s = String(raw).trim();
  if (s === "" || s === "~" || s === "null") return undefined;
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    s = s.slice(1, -1);
  }
  const hash = s.indexOf(" #");
  if (hash >= 0) s = s.slice(0, hash).trim();
  return s === "" ? undefined : s;
}

/** 值一律加双引号：网盘专用密码可能含 `#`、`: ` 等在 YAML 里有含义的字符。 */
function quoteValue(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 在 refs: 块内 upsert 一个键。返回 {text, changed, action, line}。
 * action: "replace" | "insert-in-refs" | "create-refs" | "remove" | "noop"
 */
function upsertRef(text, ref, value) {
  const hadTrailingNewline = /\r?\n$/.test(text) || text === "";
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let refsStart = -1;
  let refsEnd = lines.length;
  let refsIndent = 0;
  let childIndent = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && /^refs\s*:/.test(line.trim())) {
      refsStart = i;
      refsIndent = indent;
      for (let j = i + 1; j < lines.length; j += 1) {
        const l2 = lines[j];
        if (l2.trim() === "" || l2.trimStart().startsWith("#")) continue;
        const ind2 = l2.length - l2.trimStart().length;
        if (ind2 <= refsIndent) {
          refsEnd = j;
          break;
        }
      }
      break;
    }
  }

  const build = (target, indent) => `${" ".repeat(indent)}${target}: ${quoteValue(value)}`;
  const rebuild = (arr) => arr.join("\n") + (hadTrailingNewline ? "\n" : "");

  if (refsStart >= 0) {
    for (let j = refsStart + 1; j < refsEnd; j += 1) {
      const line = lines[j];
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;
      if (childIndent === 0) childIndent = indent;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line.trim());
      if (m && m[1] === ref) {
        const before = lines[j];
        if (value === undefined) {
          lines.splice(j, 1);
          return { text: rebuild(lines), changed: true, action: "remove", line: before };
        }
        lines[j] = build(ref, indent);
        return {
          text: rebuild(lines),
          changed: before !== lines[j],
          action: "replace",
          line: `${before}  →  ${lines[j]}`,
        };
      }
    }
    if (value === undefined) return { text, changed: false, action: "noop", line: undefined };
    const indent = childIndent > 0 ? childIndent : refsIndent + 2;
    let at = refsEnd;
    while (at - 1 > refsStart && (lines[at - 1].trim() === "" || lines[at - 1].trimStart().startsWith("#"))) at -= 1;
    lines.splice(at, 0, build(ref, indent));
    return { text: rebuild(lines), changed: true, action: "insert-in-refs", line: lines[at] };
  }

  if (value === undefined) return { text, changed: false, action: "noop", line: undefined };
  if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
  lines.push("refs:");
  lines.push(build(ref, 2));
  return {
    text: lines.join("\n") + "\n",
    changed: true,
    action: "create-refs",
    line: `refs:\n  ${build(ref, 2)}`,
  };
}

/* ----------------------------- 口令获取 ----------------------------- */

function readFromEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") {
    die(`环境变量 ${name} 未设置或为空。`, 1);
  }
  return raw.trim();
}

/** 隐藏输入：raw mode 逐字符读，不回显、不进 shell history。 */
async function promptHidden(label) {
  if (!process.stdin.isTTY) {
    die("当前不是交互式终端。请改用 --from-env <VAR> 方式传入专用密码。", 1);
  }
  return await new Promise((resolve, reject) => {
    process.stdout.write(label);
    const chars = [];
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(chars.join(""));
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("已取消（Ctrl-C）"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          chars.pop();
          continue;
        }
        chars.push(ch);
      }
    };
    stdin.on("data", onData);
  });
}

/* ---------------------------- 远端校验 ---------------------------- */

/**
 * 从 cordis.patch.yml 里抽 webdavUrl / webdavUsername。
 * 不用 YAML 库（插件目录没有 node_modules），只认 `- key: value` 形态的行。
 */
function readPatchTarget(pluginDir, home) {
  const file = path.join(pluginDir, "cordis.patch.yml");
  const out = { url: undefined, username: undefined, source: file };
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, "utf8");
  const grab = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*'?([^'\\n]*)'?\\s*$`, "m").exec(text);
    return m && m[1].trim() !== "" ? m[1].trim() : undefined;
  };
  out.url = grab("webdavUrl");
  out.username = grab("webdavUsername");
  // patch 里没填时，退回 config-manager 的配置做**只读参考**（不写回 patch）
  if (!out.url || !out.username) {
    const cm = path.join(home, "dsh-config-manager", "sync", "sync-config.json");
    if (fs.existsSync(cm)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cm, "utf8"));
        const webdav = cfg && cfg.webdav;
        if (webdav) {
          if (!out.url && typeof webdav.url === "string") out.url = webdav.url;
          if (!out.username && typeof webdav.username === "string") out.username = webdav.username;
          if (out.url && out.username) out.source = cm;
        }
      } catch {
        /* 配置文件损坏不影响主流程 */
      }
    }
  }
  return out;
}

function propfind(url, username, password) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const auth = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    const req = mod.request(
      {
        method: "PROPFIND",
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: {
          Authorization: `Basic ${auth}`,
          Depth: "1",
          "Content-Type": "application/xml; charset=utf-8",
          "User-Agent": "DSH-Sync-Backup-webdav-setup",
        },
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks).length });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("请求超时（30s）")));
    req.on("error", reject);
    req.end();
  });
}

/* ------------------------------ 主流程 ------------------------------ */

function parseArgs(argv) {
  const opts = { mode: "prompt", envName: SLOT, verify: false, dryRun: false, backup: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") opts.mode = "check";
    else if (a === "--remove") opts.mode = "remove";
    else if (a === "--from-env") {
      opts.mode = "env";
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts.envName = next;
        i += 1;
      }
    } else if (a === "--verify") opts.verify = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-backup") opts.backup = false;
    else if (a === "-h" || a === "--help") opts.mode = "help";
    else die(`未知参数：${a}（用 --help 看用法）`, 1);
  }
  return opts;
}

const HELP = `set-webdav-password.mjs — 把 WebDAV 专用密码写入凭据槽位 ${SLOT}

  node tools/set-webdav-password.mjs --check            只读：槽位是否已配置
  node tools/set-webdav-password.mjs                    交互式隐藏输入（推荐）
  node tools/set-webdav-password.mjs --from-env [VAR]   从环境变量读取（缺省 ${SLOT}）
  node tools/set-webdav-password.mjs --remove           删除槽位（先备份）
  node tools/set-webdav-password.mjs --verify           写入后发 PROPFIND 验证口令可用
  node tools/set-webdav-password.mjs --dry-run          演练，不落盘
  node tools/set-webdav-password.mjs --no-backup        跳过备份

凭据文件：$DSH_HOME/.credentials.yaml（缺省 ~/.dsh/.credentials.yaml）

注意：本插件不复用 config-manager 的槽位。坚果云的「应用专用密码」在
网页版「账户信息 → 安全选项 → 添加应用密码」里生成，**不是**登录密码。
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === "help") {
    info(HELP);
    return;
  }

  const home = resolveHome();
  const file = path.join(home, ".credentials.yaml");

  if (opts.mode === "check") {
    info(`凭据文件: ${file}${fs.existsSync(file) ? "" : "（不存在）"}`);
    if (!fs.existsSync(file)) {
      info(`槽位 ${SLOT}: 未配置`);
      return;
    }
    const value = readRef(fs.readFileSync(file, "utf8"), SLOT);
    info(`槽位 ${SLOT}: ${typeof value === "string" && value !== "" ? `已配置（${describe(value)}，值已掩码）` : "未配置"}`);
    return;
  }

  if (!fs.existsSync(home)) {
    die(`DSH 家目录不存在：${home}（请先确认 DSH_HOME 或先启动过 DSH）`, 2);
  }

  let secret;
  if (opts.mode === "env") {
    secret = readFromEnv(opts.envName);
    info(`已从环境变量 ${opts.envName} 读取专用密码：${describe(secret)}`);
  } else if (opts.mode === "remove") {
    secret = undefined;
  } else {
    secret = (await promptHidden("请输入 WebDAV 专用密码（输入不回显，回车确认）：")).trim();
    if (secret === "") die("未输入任何内容，已取消。", 1);
    info(`已读取专用密码：${describe(secret)}`);
  }

  if (typeof secret === "string") {
    if (!VALUE_RE.test(secret)) {
      die("密码格式可疑（只允许可见 ASCII，长度 4–255，不得含空格）。为避免把错值写进凭据文件，已中止。", 1);
    }
    if (/\s/.test(secret)) die("密码含空白字符，已中止。", 1);
  }

  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const { text, changed, action, line } = upsertRef(original, SLOT, secret);

  info("");
  info(`凭据文件: ${file}`);
  info(`槽位    : ${SLOT}`);
  info(`动作    : ${action}`);

  if (opts.dryRun) {
    info("演练模式：不落盘。");
    if (line) info(`将变更的行：\n  ${line}`);
    if (!changed) info("（无实际变更）");
    return;
  }

  if (!changed) {
    info("（无实际变更，未写入）");
  } else {
    if (opts.backup && original !== "") {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const bak = `${file}.bak-${stamp}`;
      fs.writeFileSync(bak, original, { mode: 0o600 });
      info(`备份    : ${bak}`);
    }
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
    info(`已写入  : ${text.length} 字节`);
  }

  if (opts.verify && typeof secret === "string") {
    const pluginDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
    const target = readPatchTarget(pluginDir, home);
    const url = process.env.WEBDAV_URL || target.url;
    const username = process.env.WEBDAV_USERNAME || target.username;
    if (!url || !username) {
      info("! 无法验证：缺少目标地址或用户名（在 cordis.patch.yml 填 webdavUrl / webdavUsername，或用环境变量 WEBDAV_URL / WEBDAV_USERNAME 覆盖）");
    } else {
      info(`目标    : ${url}（用户 ${username}，来源 ${target.source}）`);
      try {
        const r = await propfind(url, username, secret);
        // 207 Multi-Status = 正常；401 = 口令不对；405 = 地址不支持 PROPFIND（但认证通过了）
        if (r.status === 207) info(`✔ 口令可用：PROPFIND → 207 Multi-Status（${r.bytes} 字节）`);
        else if (r.status === 401) info("✘ 口令被拒绝：HTTP 401 —— 请确认用的是「应用专用密码」而不是登录密码");
        else if (r.status === 405) info("△ 认证通过但地址不支持 PROPFIND（405）—— 口令本身可能是好的");
        else info(`△ PROPFIND → HTTP ${r.status}（需自行确认）`);
      } catch (err) {
        info(`! 校验请求失败：${err.message}（口令仍已被写入）`);
      }
    }
  }

  info("");
  info("验证命令：");
  info("  node tools/set-webdav-password.mjs --check");
  info("  node tools/upload-once.mjs --list        # 需要先配好通道并关掉 dryRun");
  info("");
  info("读取方式：");
  info(`  环境变量 启动 DSH 前 export ${SLOT}=...   （优先级最高，启动时快照）`);
  info(`  文件层   本脚本写入的 ${file} 的 refs: 块（DSH 自动重载）`);
  info(`  运行期   ctx.credentials.resolve(credentialRef('${SLOT}'))`);
  info("");
  info("GUI 不会回显已保存的密码 —— 忘记的话重新跑一次本脚本覆盖即可。");
  if (secret !== undefined) info(`掩码回显: ${mask(secret)}`);
}

main().catch((err) => die(err && err.message ? err.message : String(err), 1));
