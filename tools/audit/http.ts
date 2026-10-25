export let NAV: any = null
export function setNav(v: any) { NAV = v }
export function buildUrl(u: string, _p?: any) { return u }
export async function request(_url: string) { return { ok: true, status: 200, json: NAV, text: '' } }
