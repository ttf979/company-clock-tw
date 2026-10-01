import {getStore} from '@netlify/blobs';
import {randomBytes} from 'node:crypto';
const store=()=>getStore({name:'dancehall-shared',consistency:'strong'});
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const text=(v:unknown,max=40)=>String(v??'').trim().slice(0,max);
function finish(p:any,now:number){const totalMs=now-p.start;return {...p,end:now,totalMs,billMin:Math.max(30,Math.ceil(totalMs/60000/30)*30),pay:Math.max(30,Math.ceil(totalMs/60000/30)*30)*10,status:'ended',events:[...p.events,{type:'下班結算',at:now}]};}
export default async function hall(req:Request,path:string){
 const db=store(),result=await db.getWithMetadata('hall',{type:'json'});const data:any=result?.data||{guests:[],active:{},history:[],receipts:[]};
 if(path==='state'&&req.method==='GET')return reply({...data,serverNow:Date.now(),rate:600,unitMin:30});
 if(req.method!=='POST')return reply({error:'不支援此操作'},405);
 let b:any;try{b=await req.json()}catch{return reply({error:'資料格式錯誤'},400)}const now=Date.now();let output:any={ok:true};
 if(path==='guest'){
  const name=text(b.name),room=text(b.room);if(!name||!room)return reply({error:'請填入客人稱呼與包廂'},400);
  const existing=data.guests.find((g:any)=>!g.closedAt&&g.name===name&&g.room===room); if(existing)return reply({ok:true,guest:existing});
  const guest={id:randomBytes(12).toString('hex'),name,room,createdAt:now,closedAt:null};data.guests.unshift(guest);output.guest=guest;
 }else if(path==='start'){
  const employee=text(b.employee);if(!employee)return reply({error:'請填入小姐稱呼'},400);
  let guest:any;
  if(b.guestId){guest=data.guests.find((g:any)=>g.id===b.guestId&&!g.closedAt);if(!guest)return reply({error:'此客人已結帳，請重新選擇'},400);}
  else {const name=text(b.guestName),room=text(b.room);if(!name||!room)return reply({error:'請填入客人稱呼與包廂'},400);
   guest=data.guests.find((g:any)=>!g.closedAt&&g.name===name&&g.room===room);
   if(!guest){guest={id:randomBytes(12).toString('hex'),name,room,createdAt:now,closedAt:null};data.guests.unshift(guest);}}
  const existing=Object.values(data.active).find((p:any)=>p.guestId===guest.id&&p.employee===employee) as any;
  if(existing)return reply({ok:true,id:existing.id,guest,alreadyActive:true});
  output.guest=guest;
  const id=randomBytes(12).toString('hex');data.active[id]={id,guestId:guest.id,guestName:guest.name,room:guest.room,employee,start:now,status:'room',awayAt:null,events:[{type:'上班',at:now}]};output.id=id;
 }else if(['transfer','return','out'].includes(path)){
  const p=data.active[b.id];if(!p)return reply({error:'這筆服務已結束，請重新整理'},409);
  if(path==='transfer'){if(p.status!=='room')return reply({error:'目前已是轉台中'},409);p.status='transfer';p.awayAt=now;p.events.push({type:'轉台',at:now});}
  if(path==='return'){if(p.status!=='transfer')return reply({error:'目前不是轉台中'},409);p.events.push({type:'回台',at:now,awayMs:now-p.awayAt});p.status='room';p.awayAt=null;}
  if(path==='out'){const record=finish(p,now);data.history.unshift(record);delete data.active[b.id];output.record=record;}
 }else if(path==='checkout'){
  const guest=data.guests.find((g:any)=>g.id===b.guestId);if(!guest||guest.closedAt)return reply({error:'此客人已結帳或不存在'},409);
  for(const p of Object.values(data.active) as any[]){if(p.guestId===guest.id){data.history.unshift(finish(p,now));delete data.active[p.id];}}
  const records=data.history.filter((h:any)=>h.guestId===guest.id);guest.closedAt=now;const receipt={id:randomBytes(12).toString('hex'),guestId:guest.id,name:guest.name,room:guest.room,at:now,total:records.reduce((sum:number,h:any)=>sum+h.pay,0),records};data.receipts.unshift(receipt);output.receipt=receipt;
 }else return reply({error:'找不到功能'},404);
 const write=await db.setJSON('hall',data,result?.etag?{onlyIfMatch:result.etag}:{onlyIfNew:true});if(!write.modified)return reply({error:'其他人剛更新資料，已重新整理，請再按一次'},409);return reply(output);
}
