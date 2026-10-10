/**
 * dsh-sync-backup / tools/_hooks.mjs
 *
 * 仅供本地 smoke 测试：把 `@deepseek-ai/*` 服务包重定向到 tools/_stubs/ 下的
 * 最小替身。**不参与插件运行**——真实插件在 DSH Host loader 下由 profile 解析这些包。
 */

import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const MAP = {
  "@deepseek-ai/schemastery": path.join(here, "_stubs", "schemastery.js"),
  "@deepseek-ai/dsh-tools": path.join(here, "_stubs", "dsh-tools.js"),
};

export async function resolve(specifier, context, nextResolve) {
  const hit = MAP[specifier];
  if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true, format: "module" };
  return nextResolve(specifier, context);
}
