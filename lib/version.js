/**
 * 版本号的**唯一来源**。
 *
 * 以前 User-Agent 把 `0.2.0` 写死在 webdav.js 与 github.js 里，而
 * package.json 是 `0.1.0` —— 出问题时从 User-Agent / 诊断信息里读到的版本
 * 和实际装的不是一回事，等于把线索弄脏了。这里从 package.json 读一次并缓存，
 * 让所有需要版本的地方取同一个值。
 *
 * 零第三方依赖。
 *
 * @module dsh-sync-backup/lib/version
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** package.json 里的版本号；读不到时回退 "0.0.0"（绝不因此让插件起不来）。 */
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** 各通道的 User-Agent：同一版本来源，只区分通道名。 */
export function userAgent(channel) {
  return `DSH-Sync-Backup/${VERSION} (${channel})`;
}

export default { VERSION, userAgent };
