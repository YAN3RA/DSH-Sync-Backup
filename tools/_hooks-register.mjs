/**
 * dsh-sync-backup / tools/_hooks-register.mjs
 *
 * 注册 module 解析钩子（见 _hooks.mjs）。用法：
 *   node --import ./tools/_hooks-register.mjs tools/smoke.mjs
 *
 * 仅在本地测试时使用；真实运行由 DSH Host loader 解析 `@deepseek-ai/*`。
 */

import { register } from "node:module";

// new URL(...) 已经产出 file:// URL；直接取 .href（再套 pathToFileURL 会因收到 URL 而报错）
register(new URL("./_hooks.mjs", import.meta.url).href);
