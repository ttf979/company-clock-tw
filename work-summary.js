(function(){
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'});
 function workDate(timestamp){const date=new Date(timestamp);if(!Number.isFinite(date.getTime()))return '';const parts=formatter.formatToParts(date);return ['year','month','day'].map(key=>parts.find(p=>p.type===key).value).join('-');}
 function summarize(receipts,employee,day){const unique=new Map();for(const receipt of receipts||[]){for(const record of receipt.records||[]){if(record.id&&record.employee===employee&&!unique.has(record.id))unique.set(record.id,{...record,guestName:record.guestName||receipt.name,room:record.room||receipt.room,guestId:record.guestId||receipt.guestId});}}
 const all=[...unique.values()],dates=[...new Set(all.map(r=>workDate(r.start)).filter(Boolean))].sort().reverse(),rows=all.filter(r=>workDate(r.start)===day).sort((a,b)=>a.start-b.start),groups=new Map();for(const row of rows){const key=row.guestId||JSON.stringify([row.guestName,row.room]);if(!groups.has(key))groups.set(key,{key,name:row.guestName,room:row.room,total:0,billMin:0,records:[]});const group=groups.get(key);group.total+=Number(row.pay)||0;group.billMin+=Number(row.billMin)||0;group.records.push(row);}
 return {date:day,dates,total:rows.reduce((sum,row)=>sum+(Number(row.pay)||0),0),billMin:rows.reduce((sum,row)=>sum+(Number(row.billMin)||0),0),count:rows.length,guests:[...groups.values()]};}
 window.hallWorkSummary={workDate,summarize};
})();
