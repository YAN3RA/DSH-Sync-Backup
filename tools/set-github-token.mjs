#!/usr/bin/env node
/**
 * set-github-token.mjs — 把 GitHub PAT 写入 DSH 凭据槽位。
 *
 * 凭据槽位（DSH 官方凭据层，见 README「凭据槽位」一节）：
 *   文件   $DSH_HOME/.credentials.yaml        （缺省 DSH_HOME = ~/.dsh）
 *   层级   refs: 块，键名 = 环境变量名
 *   槽位   DSH_SYNC_BACKUP_GITHUB_TOKEN
 *
 * 设计口径：
 *   - 令牌**只**经环境变量或本进程的隐藏输入进入，绝不作为命令行参数
 *     （命令行参数会进 shell history 与进程表）。
 *   - 令牌**绝不**写进 stdout / stderr / 日志 / 本脚本 / cordis.patch.yml。
 *   - 写盘前先备份原文件；写入用「临时文件 + rename」原子替换。
 *   - 只改 refs: 块里的目标键，文件其余内容（records、其他 refs、注释）原样保留。
 *   - 依赖：仅 Node 内置模块（插件目录没有 node_modules）。
 *
 * 用法：
 *   node tools/set-github-token.mjs --check
 *       只读：报告槽位是否已配置（不显示值）。
 *   node tools/set-github-token.mjs --from-env
 *       从 $DSH_SYNC_BACKUP_GITHUB_TOKEN 读取并写入。
 *   node tools/set-github-token.mjs --from-env GH_TOKEN
 *       从指定环境变量读取。
 *   node tools/set-github-token.mjs
 *       交互式隐藏输入（终端不回显）。这是推荐的日常方式。
 *   node tools/set-github-token.mjs --verify
 *       写入后顺带调 GET /user 校验令牌有效并打印账号名。
 *   node tools/set-github-token.mjs --remove
 *       删除该槽位（同样先备份）。
 *   node tools/set-github-token.mjs --dry-run
 *       演练：打印将要发生的行级变更（值一律掩码），不落盘。
 *
 * 退出码：0 成功 / 1 用法或校验错误 / 2 环境问题（家目录或文件不可写）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import https from "node:https";

/** 环境变量名（DSH 凭据 refs 层的键）。 */
const SLOT = "DSH_SYNC_BACKUP_GITHUB_TOKEN";

/**
 * 已知 PAT 前缀。刻意用字符串拼接而非字面量：避免本文件被密钥扫描器
 * 误判为「里面藏了一个令牌」。
 */
const KNOWN_PREFIXES = [
  "gh" + "p_", // classic PAT
  "github" + "_pat_", // fine-grained PAT
];

/** 令牌值的字符集与长度粗校验（GitHub 目前 40+ 字符，留足余量）。 */
const VALUE_RE = /^[A-Za-z0-9_-]{20,255}$/;

/* ------------------------------ 小工具 ------------------------------ */

function die(msg, code = 1) {
  process.stderr.write(`错误：${msg}\n`);
  process.exit(code);
}

function info(msg) {
  process.stdout.write(`${msg}\n`);
}

/** 永不回显令牌：只给前缀类型与长度。 */
function describeToken(value) {
  const kind = KNOWN_PREFIXES.find((p) => value.startsWith(p));
  const label = kind ? "fine-grained" : "classic/未知";
  if (kind) {
    const short = kind === KNOWN_PREFIXES[1] ? "fine-grained" : "classic";
    return `类型 ${short}，长度 ${value.length}`;
  }
  return `类型 ${label}，长度 ${value.length}`;
}

function mask(value) {
  if (typeof value !== "string" || value.length === 0) return "(空)";
  return `${value.slice(0, 4)}${"*".repeat(Math.min(12, Math.max(0, value.length - 4)))}（长度 ${value.length}）`;
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
 * 不支持 anchors / 流式集合 / 多行标量 —— 目标文件的实际结构也不需要。
 */
function readRef(text, ref) {
  const lines = text.split(/\r?\n/);
  let currentTop = null;
  let currentIndent = 0;
  let inRefs = false;
  let refsIndent = 0;
  let found;

  for (const line of lines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;

    if (indent === 0) {
      currentTop = m[1];
      currentIndent = 0;
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
      continue;
    }

    // 其他顶层块的嵌套键：只有 `currentTop === null` 时不参与
    void currentTop;
    void currentIndent;
  }
  return found;
}

function parseScalar(raw) {
  let s = String(raw).trim();
  if (s === "" || s === "~" || s === "null") return undefined;
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    s = s.slice(1, -1);
  }
  // 行尾注释（仅在值未被引号包裹时）
  const hash = s.indexOf(" #");
  if (hash >= 0) s = s.slice(0, hash).trim();
  return s === "" ? undefined : s;
}

function quoteValue(value) {
  // 令牌只含 [A-Za-z0-9_-]，不需要引号；引号是为将来放宽字符集留的后路。
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
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
      // 找块结束：下一个缩进 <= refsIndent 的非空非注释行
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
          refsEnd -= 1;
          return { text: lines.join("\n") + (hadTrailingNewline ? "\n" : ""), changed: true, action: "remove", line: before };
        }
        lines[j] = build(ref, indent);
        return { text: lines.join("\n") + (hadTrailingNewline ? "\n" : ""), changed: before !== lines[j], action: "replace", line: `${before}  →  ${lines[j]}` };
      }
      void indent;
    }
    if (value === undefined) {
      return { text, changed: false, action: "noop", line: undefined };
    }
    const indent = childIndent > 0 ? childIndent : refsIndent + 2;
    // 插到 refs 块末尾（若不巧块尾是空行/注释，紧邻其前插入）
    let at = refsEnd;
    while (at - 1 > refsStart && (lines[at - 1].trim() === "" || lines[at - 1].trimStart().startsWith("#"))) at -= 1;
    lines.splice(at, 0, build(ref, indent));
    return { text: lines.join("\n") + (hadTrailingNewline ? "\n" : ""), changed: true, action: "insert-in-refs", line: lines[at] };
  }

  if (value === undefined) {
    return { text, changed: false, action: "noop", line: undefined };
  }
  // 没有 refs: 块 —— 在文件末尾新建
  if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
  lines.push("refs:");
  lines.push(build(ref, 2));
  return { text: lines.join("\n") + "\n", changed: true, action: "create-refs", line: `refs:\n  ${build(ref, 2)}` };
}

/* ----------------------------- 令牌获取 ----------------------------- */

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
    die("当前不是交互式终端。请改用 --from-env <VAR> 方式传入令牌。", 1);
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

function httpsJson(method, url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method,
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "DSH-Sync-Backup-token-setup",
        },
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("请求超时（30s）"));
    });
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
    else die(`未知参数：${a}（用 --help 看用法）`);
  }
  return opts;
}

const HELP = `set-github-token.mjs — 把 GitHub PAT 写入 DSH 凭据槽位 ${SLOT}

  node tools/set-github-token.mjs --check            只读：槽位是否已配置
  node tools/set-github-token.mjs                    交互式隐藏输入（推荐）
  node tools/set-github-token.mjs --from-env [VAR]   从环境变量读取（缺省 ${SLOT}）
  node tools/set-github-token.mjs --remove           删除槽位（先备份）
  node tools/set-github-token.mjs --verify           写入后调 GET /user 校验
  node tools/set-github-token.mjs --dry-run          演练，不落盘
  node tools/set-github-token.mjs --no-backup        跳过备份

凭据文件：$DSH_HOME/.credentials.yaml（缺省 ~/.dsh/.credentials.yaml）
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
    const text = fs.readFileSync(file, "utf8");
    const value = readRef(text, SLOT);
    if (typeof value === "string" && value !== "") {
      info(`槽位 ${SLOT}: 已配置（${describeToken(value)}，值已掩码）`);
    } else {
      info(`槽位 ${SLOT}: 未配置`);
    }
    return;
  }

  if (!fs.existsSync(home)) {
    die(`DSH 家目录不存在：${home}（请先确认 DSH_HOME 或先启动过 DSH）`, 2);
  }

  let token;
  if (opts.mode === "env") {
    token = readFromEnv(opts.envName);
    info(`已从环境变量 ${opts.envName} 读取令牌：${describeToken(token)}`);
  } else if (opts.mode === "remove") {
    token = undefined;
  } else {
    token = (await promptHidden(`请输入 GitHub PAT（输入不回显，回车确认）：`)).trim();
    if (token === "") die("未输入任何内容，已取消。", 1);
    info(`已读取令牌：${describeToken(token)}`);
  }

  if (typeof token === "string") {
    if (!VALUE_RE.test(token)) {
      die("令牌格式可疑（只允许 A-Za-z0-9_-，长度 20–255）。为避免把错值写进凭据文件，已中止。", 1);
    }
    if (!KNOWN_PREFIXES.some((p) => token.startsWith(p))) {
      info("提示：令牌前缀不属于已知的 classic / fine-grained 形态，仍按原样写入。");
    }
    if (opts.verify) {
      try {
        const r = await httpsJson("GET", "https://api.github.com/user", token);
        if (r.status === 200) {
          const me = JSON.parse(r.body);
          info(`✔ 令牌有效：账号 ${me.login}（GET /user → 200）`);
        } else {
          info(`✘ 校验未通过：GET /user → HTTP ${r.status}（令牌仍会被写入，请自行确认）`);
        }
      } catch (err) {
        info(`! 校验请求失败：${err.message}（令牌仍会被写入）`);
      }
    }
  }

  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const { text, changed, action, line } = upsertRef(original, SLOT, token);

  info("");
  info(`凭据文件: ${file}`);
  info(`槽位    : ${SLOT}`);
  info(`动作    : ${action}`);

  if (opts.dryRun) {
    info(`演练模式：不落盘。`);
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

  info("");
  info("验证命令：");
  info("  node tools/set-github-token.mjs --check");
  info("  node tools/upload-once.mjs --list        # 需要先配好通道");
  info("");
  info("读取方式：");
  info(`  环境变量 启动 DSH 前 export ${SLOT}=...   （优先级最高，启动时快照）`);
  info(`  文件层   本脚本写入的 ${file} 的 refs: 块（DSH 自动重载）`);
  info(`  运行期   ctx.credentials.resolve(credentialRef('${SLOT}'))`);
  if (token !== undefined) info(`掩码回显: ${mask(token)}`);
}

main().catch((err) => die(err && err.message ? err.message : String(err), 1));
