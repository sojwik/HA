'use strict';
/* Odczyt istniejących statystyk HA, NIE logowanie ani wymuszanie odświeżenia
 * Taurona. Osobny klient: stare ha-ws i wszystkie endpointy PV nietknięte. */
const WebSocket=require('ws'),crypto=require('crypto');
const M=require('../public/ami-model'),D=require('../public/pv-data'),Store=require('./ami-store');
const receipts=new Map(),TTL=10*60*1000;
function request(command) {
  return new Promise((resolve,reject)=>{
    const token=process.env.SUPERVISOR_TOKEN;
    if(!token){reject(Error('Brak dostępu dodatku do API Home Assistant. Import CSV/XLSX nadal działa.'));return;}
    let ws,done=false;
    function finish(error,result){if(done)return;done=true;clearTimeout(timer);if(ws)try{ws.close();}catch(_){}error?reject(error):resolve(result);}
    const timer=setTimeout(()=>finish(Error('HA nie odpowiedział w ciągu 30 sekund. Zachowano dane; możesz użyć CSV/XLSX.')),30000);
    try{ws=new WebSocket(process.env.HA_WS_URL||'ws://supervisor/core/websocket',{maxPayload:8*1024*1024});}
    catch(e){finish(Error('Nie udało się połączyć z Home Assistant.'));return;}
    ws.on('message',raw=>{
      try{
        const m=JSON.parse(raw);
        if(m.type==='auth_required'){ws.send(JSON.stringify({type:'auth',access_token:token}));return;}
        if(m.type==='auth_invalid'){finish(Error('HA odmówił dostępu. Nie przesyłaj tokenu ani hasła w rozmowie.'));return;}
        if(m.type==='auth_ok'){ws.send(JSON.stringify({id:1,...command}));return;}
        if(m.type==='result'&&m.id===1){
          if(m.success!==true)finish(Error('HA odmówił odczytu statystyk AMIplus. Zachowano istniejące dane.'));
          else finish(null,m.result);
        }
      }catch(e){finish(Error('Nieprawidłowa odpowiedź Home Assistant.'));}
    });
    ws.on('error',()=>finish(Error('Błąd połączenia z Home Assistant. Zachowano dane.')));
    ws.on('close',()=>finish(Error('Połączenie z Home Assistant zostało przerwane.')));
  });
}
async function meters() {return M.discover(await request({type:'recorder/list_statistic_ids',statistic_type:'sum'}));}
function prune(){const now=Date.now();for(const [k,v]of receipts)if(now-v.at>TTL)receipts.delete(k);while(receipts.size>=32)receipts.delete(receipts.keys().next().value);}
function responseError(res,error,defaultStatus=502){res.status(error.status||defaultStatus).json({error:error.message});}
function register(app) {
  app.get('/api/ami/meters',async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{
      const groups=await meters();
      res.json({kind:'ami_meters_v1',through:M.yesterday(),meters:groups.map(g=>({meter:g.meter,label:g.label,ready:g.ready,problems:g.problems}))});
    }catch(e){responseError(res,e);}
  });
  app.get('/api/ami/context',(req,res)=>{
    res.set('Cache-Control','no-store');
    try{res.json(Store.context());}catch(e){responseError(res,e,503);}
  });
  app.post('/api/ami/read',async(req,res)=>{
    res.set('Cache-Control','no-store');
    const b=req.body;let range;
    try{
      if(!b||Array.isArray(b)||typeof b.meter!=='string'||!/^[a-z0-9_]{1,160}$/.test(b.meter))throw Error('Wybierz licznik AMIplus w tym dodatku.');
      range=M.span(b.from,b.through,Date.now(),31);
    }catch(e){responseError(res,e,400);return;}
    try{
      const g=(await meters()).find(g=>g.meter===b.meter);
      if(!g||!g.ready)throw Error('Wybrany licznik nie ma potwierdzonych statystyk poboru i oddania po bilansowaniu.');
      const data=await request({type:'recorder/statistics_during_period',statistic_ids:g.ids,
        start_time:new Date(range.start-M.HOUR).toISOString(),end_time:new Date(range.end).toISOString(),
        period:'hour',types:['state','sum'],units:{energy:'kWh'}});
      const normalized=M.normalize(g,data,b.from,b.through),receipt=crypto.randomBytes(24).toString('hex');
      prune();receipts.set(receipt,{at:Date.now(),meter:g.meter,from:b.from,through:b.through,rows:normalized.rows});
      res.json({...normalized,receipt});
    }catch(e){responseError(res,e);}
  });
  app.post('/api/ami/commit',(req,res)=>{
    res.set('Cache-Control','no-store');
    try{
      const b=req.body;
      if(!b||Array.isArray(b)||!Array.isArray(b.receipts)||!b.receipts.length||b.receipts.length>13
        ||new Set(b.receipts).size!==b.receipts.length)throw Error('Nieprawidłowy zestaw odczytów AMIplus.');
      const all=b.receipts.map(id=>typeof id==='string'?receipts.get(id):null);
      if(all.some(x=>!x||Date.now()-x.at>TTL))throw Error('Odczyt AMI wygasł lub został już użyty. Pobierz dane ponownie; nie usuwaj historii.');
      const meter=all[0].meter;
      if(all.some(x=>x.meter!==meter))throw Error('Nie można łączyć odczytów różnych liczników.');
      const sorted=[...all].sort((x,y)=>x.from.localeCompare(y.from));
      for(let i=1;i<sorted.length;i++)if(sorted[i].from!==D.nextDay(sorted[i-1].through))throw Error('Zakres odczytów nie jest ciągły. Niczego nie zapisano.');
      M.span(sorted[0].from,sorted.at(-1).through,Date.now(),366);
      const result=Store.commit(b.revision,meter,sorted.flatMap(x=>x.rows),b.confirmMeter===true);
      for(const id of b.receipts)receipts.delete(id);
      res.json(result);
    }catch(e){responseError(res,e,e.message.startsWith('Nie udało się zapisać')?503:400);}
  });
}
module.exports={register,request,meters};
