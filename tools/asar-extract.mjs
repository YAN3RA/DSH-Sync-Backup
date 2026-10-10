/**
 * 从 app.asar 中提取指定包内文件（只读，不修改任何东西）。
 * 用法: node tools/asar-extract.mjs <asar内路径> [输出绝对路径]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// 只读抽取 asar 内文件。路径按需覆盖，勿硬编码本机安装位置。
const ASAR =
  process.env.DSH_ASAR ??
  path.join(
    process.env.LOCALAPPDATA ?? os.homedir(),
    "Programs",
    "DeepSeek Harness",
    "resources",
    "app.asar",
  );

const fd = readFileSync(ASAR);
const headerSize = fd.readUInt32LE(12);
const header = JSON.parse(fd.subarray(16, 16 + headerSize).toString("utf8").replace(/\0+$/, ""));
const dataStart = 16 + headerSize;

function walk(node, prefix, out) {
  if (!node || typeof node !== "object") return;
  if (node.files) {
    for (const [k, v] of Object.entries(node.files)) walk(v, prefix ? `${prefix}/${k}` : k, out);
  } else if (node.offset !== undefined) {
    // asar 里 offset/size 可能是字符串，统一转数字
    out.push({ p: prefix, offset: Number(node.offset), size: Number(node.size) });
  }
}

const leaves = [];
walk({ files: header.files }, "", leaves);

const target = process.argv[2];
if (!target) {
  console.log("总叶子数:", leaves.length);
  const kw = process.argv[3] || "dsh-credentials";
  for (const l of leaves.filter((x) => x.p.includes(kw))) console.log(" ", l.p, l.size);
  process.exit(0);
}

const norm = target.replace(/\\/g, "/");
const hit = leaves.find((l) => l.p === norm) || leaves.find((l) => l.p.endsWith("/" + norm)) || leaves.find((l) => l.p.includes(norm));
if (!hit) {
  console.error("未找到:", norm);
  process.exit(1);
}
const buf = fd.subarray(dataStart + hit.offset, dataStart + hit.offset + hit.size);
const outPath = process.argv[3];
if (outPath && path.isAbsolute(outPath)) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  console.log(`已写出 ${hit.p} (${hit.size} B) -> ${outPath}`);
} else {
  console.log(`--- ${hit.p} (${hit.size} B) ---`);
  console.log(buf.toString("utf8"));
}
