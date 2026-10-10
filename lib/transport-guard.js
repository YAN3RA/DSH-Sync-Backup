/**
 * 传输安全判定：凭据**不得经明文 HTTP 发给非本机目标**。
 *
 * WebDAV 走 Basic 认证、GitHub 走 Bearer PAT —— 两者在 http: 下都是明文。
 * 所以在允许 http: 之前必须先回答一个问题：目标是不是本机？
 *
 * 允许的 http: 只有 loopback（127.0.0.0/8、::1、localhost）——
 * 那是本地假服务与自建私服的常规用法，流量不出网卡。其余一律要求 https:，
 * 除非调用方显式传 allowInsecure 且由**用户本人**在界面上确认过风险
 * （本模块只负责判定，不负责拿到那个确认）。
 *
 * 零第三方依赖。
 *
 * @module dsh-sync-backup/lib/transport-guard
 */

/** 判断主机名是否指向本机。 */
export function isLoopbackHost(hostname) {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // IPv4 loopback：整个 127.0.0.0/8。
  // 每个八位组必须 ≤255 —— 否则 127.0.0.256 这种「看起来像本机」的串会被放行，
  // 而它并不是本机地址（URL 解析通常已规范化，但这一层不该依赖上游的宽容）。
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m && m.slice(1).every((o) => Number(o) <= 255)) return true;
  return false;
}

/**
 * 校验一个外部目标的传输安全性。
 *
 * @param {string} url 已解析或待解析的绝对 URL
 * @param {{allowInsecure?: boolean, what?: string}} [opts]
 * @returns {{ok:true, loopback:boolean}|{ok:false, problem:string}}
 */
export function checkTransportUrl(url, opts = {}) {
  const what = opts.what ?? "目标地址";
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, problem: `${what} 不是合法 URL` };
  }
  if (parsed.protocol === "https:") return { ok: true, loopback: false };
  if (parsed.protocol !== "http:") {
    return { ok: false, problem: `${what} 的协议必须是 http(s): ${parsed.protocol}` };
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (loopback) return { ok: true, loopback: true };
  if (opts.allowInsecure === true) return { ok: true, loopback: false };
  return {
    ok: false,
    problem:
      `${what} 使用明文 HTTP 且目标不是本机（${parsed.hostname}）：` +
      "凭据会以明文发送。请改用 https://；仅当目标是本机私有服务时 http:// 才被接受。" +
      "（如确需对非本机使用 http，须由用户显式确认风险）",
  };
}

export default { isLoopbackHost, checkTransportUrl };
