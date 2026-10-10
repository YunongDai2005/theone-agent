/** Read-only billing adapter. Returns no account identifiers or credentials. */
import fs from 'node:fs';
export function billingTime(x) {
  if (x == null || x === '' || x === 0) return null;
  if (typeof x === 'number' || /^\d+$/.test(x)) { const n = Number(x); return n < 1e12 ? n * 1000 : n; }
  // Upstream's unzoned billing times are UTC+8, regardless of the gateway host timezone.
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(x) ? x.replace(' ', 'T') + '+08:00' : x);
  return Number.isFinite(t) ? t : null;
}
const unpack = j => { if (j.code != null && j.code !== 0) throw new Error('WB billing code ' + j.code); return j.data || j; };
export function parseBilling(summary, resources, now = Date.now()) {
  const packages = summary.Packages;
  if (!Array.isArray(packages) || !packages.length) throw new Error('WB quota schema missing');
  const total = packages.reduce((s,p) => s + Number(p.CycleTotalCapacity), 0);
  const used = packages.reduce((s,p) => s + Number(p.CycleUsedCapacity), 0);
  const remaining = packages.reduce((s,p) => s + Number(p.CycleRemainCapacity), 0);
  if (![total,used,remaining].every(Number.isFinite) || total <= 0) throw new Error('WB quota values invalid');
  const buckets = (resources || []).filter(r => [0,3].includes(Number(r.Status))).flatMap(r => {
    const start = billingTime(r.CycleStartTime || r.DeductionStartTime);
    const end = billingTime(r.CycleEndTime); // A login token's expiry is never a quota cycle boundary.
    if (!end || end <= now || start && start > now) return [];
    const capacity = Number(r.CycleCapacitySizePrecise ?? r.CycleCapacitySize);
    const left = Number(r.CycleCapacityRemainPrecise ?? r.CycleCapacityRemain);
    if (!Number.isFinite(capacity) || !Number.isFinite(left) || capacity <= 0) return [];
    return [{ label: String(r.PackageName || '月积分').slice(0,80), startsAt: start ? new Date(start).toISOString() : null,
      resetsAt: new Date(end).toISOString(), total: capacity, remaining: left }];
  });
  buckets.sort((a,b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
  const soonest = buckets.find(b => b.remaining > 0)?.resetsAt || buckets[0]?.resetsAt || null;
  // Only the allowance actually expiring at the boundary contributes to urgency.
  const expiring = buckets.filter(b => b.resetsAt === soonest).reduce((s,b) => s+b.remaining,0);
  return { quotaTotal: total, quotaUsed: used, quotaRemaining: remaining, paid: !!summary.IsPaidUser,
    usedPercent: Math.round(used/total*1000)/10, buckets, resetsAt: soonest, expiringPercent: soonest ? expiring/total*100 : null };
}
export async function readBilling(authPath) {
  // authPath must be a local credential file already managed by the installed gateway.
  const d = JSON.parse(fs.readFileSync(authPath,'utf8'));
  if (!d.auth?.accessToken) throw new Error('WB credential missing');
  const origin = /^(intl|international|global|workbuddy\.ai)$/.test(d.edition || '') ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
  const headers = { 'content-type':'application/json', Authorization:'Bearer '+d.auth.accessToken,
    'X-Client-Platform':'web', Origin:origin, Referer:origin+'/', 'X-Requested-With':'XMLHttpRequest',
    'User-Agent':'CLI/2.143.1 CodeBuddy/2.143.1', 'X-Enterprise-Id':d.account?.enterpriseId || '' };
  const signal = AbortSignal.timeout(15000);
  const request = async (endpoint, body) => {
    const r = await fetch(origin+'/billing/meter/'+endpoint,{method:'POST',headers,body:JSON.stringify(body),signal});
    if (!r.ok) throw new Error('WB billing HTTP '+r.status);
    return unpack(await r.json());
  };
  const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const [summary, resources] = await Promise.all([request('get-user-resource-summary',{}), (async()=>{
    const rows=[];let count=null;
    for(let page=1;page<=10;page++) {
      const j=await request('get-user-resource',{PageNumber:page,PageSize:200,ProductCode:'p_tcaca',Status:[0,3],OnlyValidPeriod:true,SlicePeriodStartTime:date+' 00:00:00',SlicePeriodEndTime:date+' 23:59:59'});
      const data=j.Response?.Data; if(!Array.isArray(data?.Accounts) || !Number.isFinite(Number(data.TotalCount))) throw new Error('WB cycles schema missing');
      if(count!=null && count!==Number(data.TotalCount)) throw new Error('WB cycles changed during query');
      count=Number(data.TotalCount); rows.push(...data.Accounts);
      if(rows.length===count) return rows;
      if(!data.Accounts.length || rows.length>count) throw new Error('WB cycles incomplete');
    }
    throw new Error('WB cycles pagination limit');
  })().catch(()=>null)]);
  return { ...parseBilling(summary, resources), observedAt:new Date().toISOString(), source:'WorkBuddy 上游只读积分与月周期接口' };
}
