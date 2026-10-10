/**
 * dsh-sync-backup / lib/archive.js
 *
 * 纯 Node 内置实现的 USTAR 归档 + gzip 压缩，**零第三方依赖**。
 *
 * 为什么手写而不用 `tar` 包：
 *   - 设计约定零第三方依赖，避免插件生命周期受 profile 内依赖树变动影响；
 *   - 我们只需要最朴素的「一堆普通文件 → 一个流」能力，不需要权限/硬链接/增量。
 *
 * ⚠️ 关键实现细节（审查阻塞项 B3）：USTAR 的 `name` 字段只有 100 字节、
 * `prefix` 字段只有 155 字节。本机白名单 259 条相对路径中有 45 条超过
 * 100 字节、最长 158 字节，**必须实现 name/prefix 拆分**，否则这些条目
 * 会被截断或打包失败。最长单段 69 字节、0 条超 255 → 无需 GNU/PAX 扩展头。
 *
 * @module dsh-sync-backup/lib/archive
 */

import { gunzipSync, gzipSync } from "node:zlib";

/** USTAR 块大小。 */
export const BLOCK_SIZE = 512;
/** USTAR name 字段容量（字节）。 */
export const NAME_MAX = 100;
/** USTAR prefix 字段容量（字节）。 */
export const PREFIX_MAX = 155;

/* ------------------------------------------------------------------ */
/* 底层读写                                                            */
/* ------------------------------------------------------------------ */

function writeString(buf, offset, length, str) {
  const b = Buffer.from(str, "utf8");
  if (b.length > length) {
    throw new Error(`archive: 字段溢出 offset=${offset} len=${length} 实际=${b.length} ("${str}")`);
  }
  b.copy(buf, offset);
}

function readString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  const real = end === -1 ? slice : slice.subarray(0, end);
  return real.toString("utf8");
}

/** 写八进制数字字段（长度含结尾 NUL）。 */
function writeOctal(buf, offset, length, value) {
  const digits = Math.max(0, Math.floor(value)).toString(8);
  if (digits.length > length - 1) {
    throw new Error(`archive: 八进制字段溢出 offset=${offset} len=${length} value=${value}`);
  }
  buf.write(digits.padStart(length - 1, "0") + "\0", offset, length, "ascii");
}

/** 读八进制数字字段。 */
function readOctal(buf, offset, length) {
  const s = readString(buf, offset, length).trim();
  if (s === "") return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------------ */
/* 路径拆分（长路径支持）                                              */
/* ------------------------------------------------------------------ */

/**
 * 把相对路径拆成 USTAR 的 `prefix` + `name`。
 *
 * 策略：在处理为 posix 分隔的前提下，**从最左的斜杠开始尝试**，
 * 取第一个满足 `prefix ≤ 155 字节` 且 `name ≤ 100 字节` 的切点。
 * 取最左切点可在 name 上留出最大余量。
 *
 * @param {string} rel 相对路径（反斜杠会被归一化）
 * @returns {{name: string, prefix: string}}
 */
export function splitUstarPath(rel) {
  const p = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
  if (Buffer.byteLength(p, "utf8") <= NAME_MAX) return { name: p, prefix: "" };

  for (let i = 0; i < p.length; i++) {
    if (p[i] !== "/") continue;
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (name.length === 0) continue;
    if (Buffer.byteLength(prefix, "utf8") > PREFIX_MAX) continue;
    if (Buffer.byteLength(name, "utf8") > NAME_MAX) continue;
    return { name, prefix };
  }
  throw new Error(
    `archive: 路径超出 USTAR 容量（prefix≤${PREFIX_MAX} + name≤${NAME_MAX} 字节）："${p}"（${Buffer.byteLength(p, "utf8")} 字节）`,
  );
}

/** 合并回完整相对路径。 */
export function joinUstarPath(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}

/* ------------------------------------------------------------------ */
/* 构建与解析                                                          */
/* ------------------------------------------------------------------ */

function buildHeader(path_, data, opts) {
  const { name, prefix } = splitUstarPath(path_);
  const header = Buffer.alloc(BLOCK_SIZE);

  writeString(header, 0, NAME_MAX, name);
  writeOctal(header, 100, 8, opts.mode ?? 0o644);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, Math.floor((opts.mtimeMs ?? Date.now()) / 1000));
  header.fill(0x20, 148, 156); // 校验和字段先填空格
  header[156] = 0x30; // typeflag '0' = 普通文件
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, opts.uname ?? "dsh-sync-backup");
  writeString(header, 297, 32, opts.gname ?? "dsh-sync-backup");
  if (prefix) writeString(header, 345, PREFIX_MAX, prefix);

  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

/**
 * 把条目列表打成 USTAR。
 *
 * @param {Array<{path:string,data:Buffer,mode?:number,mtimeMs?:number}>} entries
 * @returns {Buffer}
 */
export function buildTar(entries) {
  const chunks = [];
  for (const e of entries) {
    if (!Buffer.isBuffer(e.data)) throw new Error(`archive: ${e.path} 的 data 不是 Buffer`);
    chunks.push(buildHeader(e.path, e.data, e));
    chunks.push(e.data);
    const pad = (BLOCK_SIZE - (e.data.length % BLOCK_SIZE)) % BLOCK_SIZE;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2)); // 归档结束标记
  return Buffer.concat(chunks);
}

/** 校验一个 512 字节头块的 checksum 是否自洽。 */
function checksumOk(header) {
  const stored = readString(header, 148, 8).trim();
  if (stored === "") return false;
  const expected = parseInt(stored, 8);
  if (!Number.isFinite(expected)) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum === expected;
}

/**
 * 解析 USTAR 归档。
 *
 * @param {Buffer} buf
 * @param {{verifyChecksum?: boolean}} [opts]
 * @returns {Array<{path:string,data:Buffer,size:number,mode:number,mtimeMs:number}>}
 */
export function parseTar(buf, opts = {}) {
  const verify = opts.verifyChecksum !== false;
  const out = [];
  let offset = 0;

  while (offset + BLOCK_SIZE <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK_SIZE);
    let allZero = true;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    if (verify && !checksumOk(header)) {
      throw new Error(`archive: 第 ${out.length + 1} 个条目头校验和失败（offset=${offset}）`);
    }

    const magic = readString(header, 257, 6);
    if (magic !== "ustar" && magic !== "ustar\0") {
      throw new Error(`archive: 非 USTAR 格式（magic="${magic}"，offset=${offset}）`);
    }

    const name = readString(header, 0, NAME_MAX);
    const prefix = readString(header, 345, PREFIX_MAX);
    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    const mtime = readOctal(header, 136, 12);
    const typeflag = String.fromCharCode(header[156]);

    offset += BLOCK_SIZE;
    const data = buf.subarray(offset, offset + size);
    offset += size + ((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE);

    // typeflag：'0' 与 ' ' 是 USTAR 的普通文件；NUL（\0）是旧式 tar 的普通文件约定
    const isFile = typeflag === "0" || typeflag === " " || typeflag === "\0";
    if (!isFile) continue; // 仅收普通文件
    out.push({
      path: joinUstarPath(prefix, name),
      data: Buffer.from(data),
      size,
      mode,
      mtimeMs: mtime * 1000,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* gzip 封装                                                           */
/* ------------------------------------------------------------------ */

/**
 * 打成 tar 并 gzip（-9）。
 *
 * @param {Array} entries
 * @returns {{tar: Buffer, gz: Buffer, rawBytes: number, gzBytes: number}}
 */
export function buildArchive(entries) {
  const tar = buildTar(entries);
  const gz = gzipSync(tar, { level: 9 });
  return { tar, gz, rawBytes: tar.length, gzBytes: gz.length };
}

/**
 * 解开 tar.gz 并返回条目列表。
 *
 * @param {Buffer} gz
 * @param {{verifyChecksum?: boolean}} [opts]
 */
export function openArchive(gz, opts = {}) {
  return parseTar(gunzipSync(gz), opts);
}

export default { buildTar, parseTar, buildArchive, openArchive, splitUstarPath, joinUstarPath };
