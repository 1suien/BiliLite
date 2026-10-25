/**
 * `x/web-interface/nav` 响应的分类（纯函数，不依赖 electron，方便 tools/check-parsers.mjs 直接测）。
 *
 * 为什么要单独抽出来：nav 被风控（-352）、超时、5xx 时不能当成「未登录」——旧实现拿不到
 * user 就 `store.clearAuth()`，于是扫码登录后过一会儿就被自动踢下线。三种结果必须分清。
 */

/**
 * @param {any} body nav 接口返回的 JSON（可能是 null/undefined）
 * @param {number} [status] HTTP 状态码，仅用于兜底错误信息
 * @returns {{kind:'user',data:any}|{kind:'guest'}|{kind:'transient',code:number|undefined,message:string}}
 */
export function classifyNav(body, status = 200) {
  const code = body && typeof body.code === 'number' ? body.code : undefined
  const data = body && body.data
  if (code === 0 && data && data.isLogin) return { kind: 'user', data }
  // -101：账号未登录；code 0 且明确 isLogin === false：也是真的没登录
  if (code === -101 || (code === 0 && data && data.isLogin === false)) return { kind: 'guest' }
  const message =
    (body && body.message) || `登录态校验失败（code ${code === undefined ? status : code}）`
  return { kind: 'transient', code, message }
}

/** nav 的用户信息 → 我们 store 里存的 user 形状（纯函数，便于单测）。 */
export function toNavUser(data, fixUrl) {
  const face = data && data.face
  return {
    mid: data && data.mid,
    uname: data && data.uname,
    face: typeof fixUrl === 'function' ? fixUrl(face) : face,
    level: (data && data.level_info && data.level_info.current_level) || 0,
    coins: (data && data.money) || 0,
    vip: (data && data.vipStatus) === 1
  }
}

export default { classifyNav, toNavUser }
