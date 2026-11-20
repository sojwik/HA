'use strict';
/* Osobny atomowy zapis AMI. Nie zmienia implementacji ani semantyki starego KV.
 * Wszystkie miesiące + pochodny rejestr w jednym rename, porównanie rewizji
 * przed zapisem. Nie dotyka PV, cen, ustawień urządzeń ani kosztów użytkownika. */
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const kv=require('./kv'),M=require('../public/ami-model'),V=require('./validate');
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const isObject=x=>x && typeof x==='object' && !Array.isArray(x);
function parse(value,label) {
  try { const x=JSON.parse(value); if(!isObject(x))throw Error(); return x; }
  catch(e) { throw Error('Nieprawidłowy zapis '+label+'. Zachowano istniejące dane.'); }
}
function read() {
  const raw=fs.existsSync(kv.KV_FILE)?fs.readFileSync(kv.KV_FILE,'utf8'):null;
  const all=raw===null||!raw.trim()?{}:parse(raw,'magazynu');
  const hourly=Object.create(null);
  for(const key of Object.keys(all)) if(key.startsWith('elicznik-hourly-')) {
    if(!/^elicznik-hourly-20\d{2}-\d{2}$/.test(key)) throw Error('Nieprawidłowy klucz miesiąca eLicznika.');
    const part=parse(all[key],'godzin eLicznika');
    for(const hk of Object.keys(part)) {
      if(!/^20\d{2}-\d{2}-\d{2}_\d{2}$/.test(hk)||hk.slice(0,7)!==key.slice(-7)||own(hourly,hk)) throw Error('Sprzeczny zapis godzin eLicznika.');
      hourly[hk]=part[hk];
    }
  }
  const ledger=own(all,'monthly-ledger')?parse(all['monthly-ledger'],'rejestru miesięcy'):{};
  const rce=own(all,'rce-cache')?parse(all['rce-cache'],'cen RCE'):{};
  const rceHourly=rce.v===2 && isObject(rce.data)?rce.data:{};
  const binding=own(all,'ami-v1-meter')?parse(all['ami-v1-meter'],'wyboru licznika'):null;
  return {raw,all,hourly,ledger,rceHourly,binding,revision:crypto.createHash('sha256').update(raw===null?'ABSENT':raw).digest('hex')};
}
function context() { const s=read(); return {revision:s.revision,hourly:s.hourly,ledger:s.ledger,rceHourly:s.rceHourly,binding:s.binding}; }
const round2=v=>Math.round((v+Number.EPSILON)*100)/100;
function updateMonths(ledger,grid,prices,changedMonths) {
  const out=JSON.parse(JSON.stringify(ledger));
  if(!isObject(out.months))out.months={};
  for(const mk of changedMonths) {
    const rows=Object.values(grid).filter(r=>r && r.date && r.date.slice(0,7)===mk);
    let kwh=0,przypis=0,missing=0,nightSum=0,nightCount=0,pobor=0;
    const zones={};
    for(const r of rows) {
      if(!Number.isFinite(r.poborPoZbil)||r.poborPoZbil<0||!Number.isFinite(r.oddaniePoZbil)||r.oddaniePoZbil<0) throw Error('Nieprawidłowa istniejąca energia w miesiącu importu. Zachowano dane.');
      const price=prices[r.date+'_'+String(r.hour).padStart(2,'0')];
      if(!Number.isFinite(price))missing++;
      else {kwh+=r.oddaniePoZbil;przypis+=V.hourlyDepositValue(r.oddaniePoZbil,price,mk);}
      pobor+=r.poborPoZbil;
      if([1,2,3,4].includes(r.hour)){nightSum+=r.poborPoZbil;nightCount++;}
      const zone=r.strefa||'nieznana';zones[zone]=(zones[zone]||0)+r.poborPoZbil;
    }
    const rate=nightCount?nightSum/nightCount:null;
    const m=out.months[mk]||{kosztEnergii:0,kosztDystrybucji:0,manual:false};
    // Bez żadnej ceny nie zeruj wcześniej wpisanej wartości depozytu.
    if(missing<rows.length || !own(out.months,mk)){m.kwh=round2(kwh);m.przypis=round2(przypis);m.manual=false;}
    m.missingHours=missing;m.poborKwh=round2(pobor);m.nightRate=rate===null?null:round2(rate);
    m.autokonsumpcjaEstKwh=rate===null?0:round2(rows.reduce((s,r)=>s+Math.max(0,rate-r.poborPoZbil),0));
    m.poborByZone=zones;out.months[mk]=m;
  }
  return out;
}
function commit(expectedRevision,meter,rows,confirmMeter=false) {
  const s=read();
  if(typeof expectedRevision!=='string'||expectedRevision!==s.revision) { const e=Error('Dane zmieniły się w trakcie pobierania. Niczego nie nadpisano; odśwież widok przed kolejną próbą.'); e.status=409;throw e; }
  if(!/^[a-z0-9_]{1,160}$/.test(meter))throw Error('Nieprawidłowy wybór licznika.');
  if(s.binding && s.binding.meter!==meter)throw Error('Zapisane dane AMI pochodzą z innego licznika. Nie łączymy liczników.');
  if(!s.binding && confirmMeter!==true)throw Error('Potwierdź lokalnie, że wybrany licznik odpowiada danym eLicznika.');
  const merged=M.merge(s.hourly,rows);
  if(!merged.added.length)return {added:[],equal:merged.equal,conflicts:merged.conflicts,hourly:s.hourly,months:s.ledger.months||{},binding:s.binding,committed:false};
  const months=new Set(merged.added.map(k=>k.slice(0,7)));
  const ledger=updateMonths(s.ledger,merged.grid,s.rceHourly,months),all={...s.all};
  for(const mk of months)all['elicznik-hourly-'+mk]=JSON.stringify(Object.fromEntries(Object.entries(merged.grid).filter(([k])=>k.slice(0,7)===mk)));
  all['monthly-ledger']=JSON.stringify(ledger);all['ami-v1-meter']=JSON.stringify({meter});
  fs.mkdirSync(path.dirname(kv.KV_FILE),{recursive:true});
  const tmp=kv.KV_FILE+'.ami-'+crypto.randomBytes(8).toString('hex')+'.tmp';
  try {
    const fd=fs.openSync(tmp,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(all,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(tmp,kv.KV_FILE);
    try{const d=fs.openSync(path.dirname(kv.KV_FILE),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}catch(e){/* rename zakończone */}
  }catch(e){try{fs.unlinkSync(tmp);}catch(_){}throw Error('Nie udało się zapisać danych AMIplus. Nie czyść danych; sprawdź ponownie stan.');}
  return {added:merged.added,equal:merged.equal,conflicts:merged.conflicts,hourly:merged.grid,months:ledger.months,binding:{meter},committed:true,ledgerEtag:kv.etagOf(all['monthly-ledger'])};
}
module.exports={read,context,commit,updateMonths};
