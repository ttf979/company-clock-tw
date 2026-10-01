import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

const RATE = 600;
const UNIT_MIN = 30;
const SESSION_TTL = 60 * 60 * 24 * 30;

function accountsStore(){ return getStore({ name:"clock-accounts", consistency: "strong" }); }
function dataStore(){ return getStore({ name:"clock-data", consistency: "strong" }); }
function sessionsStore(){ return getStore({ name:"clock-sessions", consistency: "strong" }); }
function json(data: unknown, status=200, headers: HeadersInit={}){
  return new Response(JSON.stringify(data), {status, headers:{"content-type":"application/json; charset=utf-8", ...headers}});
}
function cleanCode(s: unknown){ return String(s ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0,24); }
function hashPassword(password:string, salt=randomBytes(16).toString("hex")){
  const hash=scryptSync(password,salt,64).toString("hex"); return {salt,hash};
}
function verifyPassword(password:string,salt:string,hash:string){
  const a=Buffer.from(hash,"hex"), b=scryptSync(password,salt,64); return a.length===b.length && timingSafeEqual(a,b);
}
function sessionKey(token:string){ return createHash("sha256").update(token).digest("hex"); }
async function issueSession(companyId:string, employeeCode?:string){
  const token=randomBytes(32).toString("base64url");
  await sessionsStore().setJSON(sessionKey(token),{companyId,employeeCode,exp:Math.floor(Date.now()/1000)+SESSION_TTL});
  return token;
}
function parseCookies(req:Request){
  const out:Record<string,string>={}; const raw=req.headers.get("cookie")||"";
  raw.split(";").forEach(p=>{ const i=p.indexOf("="); if(i>0) out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim()); }); return out;
}
async function getSession(req:Request){
  const token=parseCookies(req).clock_session; if(!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const obj:any=await sessionsStore().get(sessionKey(token),{type:"json"});
  if(!obj || obj.exp<=Date.now()/1000) return null;
  return obj;
}
function sessionCookie(token:string){ return `clock_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`; }
function clearCookie(){ return "clock_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"; }
async function body(req:Request){ try{return await req.json();}catch{return {};}}
async function getCompany(companyId:string){ return await accountsStore().get(`company/${companyId}`, {type:"json"}); }
async function getTenant(companyId:string){
  return (await dataStore().get(`tenant/${companyId}`, {type:"json"})) || { employees:[], active:{}, history:[] };
}
async function saveTenant(companyId:string,data:any){ await dataStore().setJSON(`tenant/${companyId}`,data); }
async function requireSession(req:Request){ const s=await getSession(req); if(!s) throw new Response(JSON.stringify({error:"尚未登入"}),{status:401,headers:{"content-type":"application/json"}}); return s; }

export default async (req: Request, context: Context) => {
  const url=new URL(req.url); const path=url.pathname.replace(/^\/api\/?/,"");
  try{
    if(path==="register" && req.method==="POST"){
      const b:any=await body(req); const companyCode=cleanCode(b.companyCode); const companyName=String(b.companyName||"").trim().slice(0,60); const password=String(b.password||"");
      if(companyCode.length<3 || companyName.length<2 || password.length<6) return json({error:"公司代號至少3碼、公司名稱至少2字、密碼至少6碼"},400);
      const a=accountsStore(); if(await a.get(`code/${companyCode}`)) return json({error:"公司代號已被使用"},409);
      const companyId=randomBytes(12).toString("hex"); const hp=hashPassword(password); const now=new Date().toISOString();
      await a.set(`code/${companyCode}`,companyId); await a.setJSON(`company/${companyId}`,{companyId,companyCode,companyName,...hp,createdAt:now});
      await saveTenant(companyId,{employees:[],active:{},history:[]});
      return json({ok:true,company:{companyCode,companyName} },201,{"set-cookie":sessionCookie(await issueSession(companyId))});
    }
    if(path==="login" && req.method==="POST"){
      const b:any=await body(req); const companyCode=cleanCode(b.companyCode); const password=String(b.password||""); const a=accountsStore(); const companyId=await a.get(`code/${companyCode}`);
      if(!companyId) return json({error:"公司代號或密碼錯誤"},401); const c:any=await getCompany(companyId); if(!c || !verifyPassword(password,c.salt,c.hash)) return json({error:"公司代號或密碼錯誤"},401);
      return json({ok:true,company:{companyCode:c.companyCode,companyName:c.companyName}},200,{"set-cookie":sessionCookie(await issueSession(companyId))});
    }
    if(path==="employee-login" && req.method==="POST"){
      const b:any=await body(req); const companyId=await accountsStore().get(`code/${cleanCode(b.companyCode)}`); const code=cleanCode(b.code);
      const a:any=companyId && await accountsStore().get(`employee/${companyId}/${code}`,{type:"json"});
      if(!a || !verifyPassword(String(b.password||""),a.salt,a.hash)) return json({error:"公司代號、員工代號或密碼錯誤"},401);
      return json({ok:true},200,{"set-cookie":sessionCookie(await issueSession(companyId,code))});
    }
    if(path==="logout" && req.method==="POST") {
      const token=parseCookies(req).clock_session;
      if(token && /^[A-Za-z0-9_-]{43}$/.test(token)) await sessionsStore().delete(sessionKey(token));
      return json({ok:true},200,{"set-cookie":clearCookie()});
    }
    if(path==="me" && req.method==="GET"){
      const s=await requireSession(req); const c:any=await getCompany(s.companyId); return json({company:{companyCode:c.companyCode,companyName:c.companyName},employeeCode:s.employeeCode||null,rate:RATE,unitMin:UNIT_MIN});
    }

    const s=await requireSession(req); const companyId=s.companyId; const tenant:any=await getTenant(companyId);
    if(path==="state" && req.method==="GET") return json({...(s.employeeCode ? {employees:[s.employeeCode],active:tenant.active[s.employeeCode]?{[s.employeeCode]:tenant.active[s.employeeCode]}:{},history:tenant.history.filter((h:any)=>h.code===s.employeeCode)} : tenant),serverNow:Date.now(),rate:RATE,unitMin:UNIT_MIN});
    if(s.employeeCode && !["clock-in","transfer","return","clock-out"].includes(path)) return json({error:"員工無權使用此功能"},403);
    if(path==="employees" && req.method==="POST"){
      const b:any=await body(req); const code=s.employeeCode||cleanCode(b.code); if(!code) return json({error:"請輸入員工代號"},400);
      const password=String(b.password||""); if(password.length<6) return json({error:"員工密碼至少6碼"},400);
      const key=`employee/${companyId}/${code}`; if(await accountsStore().get(key)) return json({error:"此員工帳號已存在"},409);
      await accountsStore().setJSON(key,{code,...hashPassword(password)});
      if(!tenant.employees.includes(code)) tenant.employees.push(code); await saveTenant(companyId,tenant); return json({ok:true});
    }
    if(path==="clock-in" && req.method==="POST"){
      const b:any=await body(req); const code=s.employeeCode||cleanCode(b.code); if(!code) return json({error:"請輸入員工代號"},400); const room=String(b.room||"").trim().slice(0,40),customer=String(b.customer||"").trim().slice(0,60); if(s.employeeCode && (!room||!customer)) return json({error:"請填入包廂與客戶姓名"},400); if(!tenant.employees.includes(code)) tenant.employees.push(code); if(tenant.active[code]) return json({error:"此員工已在上班中"},409);
      const now=Date.now(); tenant.active[code]={code,room,customer,events:[{type:"上班",at:now}],start:now,status:"room",roomStartedAt:now,roomAccumMs:0,transferStartedAt:null,transferAccumMs:0}; await saveTenant(companyId,tenant); return json({ok:true});
    }
    if(path==="transfer" && req.method==="POST"){
      const b:any=await body(req); const code=s.employeeCode||cleanCode(b.code); const p=tenant.active[code]; if(!p || p.status!=="room") return json({error:"目前不是包廂中"},409);
      const now=Date.now(); (p.events ||= []).push({type:"轉台",at:now}); p.roomAccumMs += now-p.roomStartedAt; p.roomStartedAt=null; p.transferStartedAt=now; p.status="transfer"; await saveTenant(companyId,tenant); return json({ok:true});
    }
    if(path==="return" && req.method==="POST"){
      const b:any=await body(req); const code=s.employeeCode||cleanCode(b.code); const p=tenant.active[code]; if(!p || p.status!=="transfer") return json({error:"目前不是轉台中"},409);
      const now=Date.now(); (p.events ||= []).push({type:"回台",at:now}); p.transferAccumMs += now-p.transferStartedAt; p.transferStartedAt=null; p.roomStartedAt=now; p.status="room"; await saveTenant(companyId,tenant); return json({ok:true});
    }
    if(path==="clock-out" && req.method==="POST"){
      const b:any=await body(req); const code=s.employeeCode||cleanCode(b.code); const p=tenant.active[code]; if(!p) return json({error:"找不到上班紀錄"},404); const end=Date.now();
      let roomMs=p.roomAccumMs, transferMs=p.transferAccumMs; if(p.status==="room"&&p.roomStartedAt) roomMs+=end-p.roomStartedAt; if(p.status==="transfer"&&p.transferStartedAt) transferMs+=end-p.transferStartedAt;
      const totalMs=end-p.start; const totalMin=totalMs/60000; const billMin=Math.max(UNIT_MIN,Math.ceil(totalMin/UNIT_MIN)*UNIT_MIN); const pay=billMin/60*RATE;
      tenant.history.unshift({id:randomBytes(8).toString("hex"),code,room:p.room||"",customer:p.customer||"",events:[...(p.events||[]),{type:"下班",at:end}],start:p.start,end,totalMs,roomMs,transferMs,billMin,pay}); tenant.history=tenant.history.slice(0,5000); delete tenant.active[code]; await saveTenant(companyId,tenant); return json({ok:true,pay,billMin});
    }
    return json({error:"找不到功能"},404);
  } catch(err:any){ if(err instanceof Response) return err; console.error(err); return json({error:"伺服器錯誤"},500); }
};

export const config: Config = { path: "/api/*" };
