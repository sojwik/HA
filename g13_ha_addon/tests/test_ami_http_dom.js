'use strict';
/* Rzeczywisty Express + klientWS + emulatorHA + pełnyDOM. Tylko dane syntetyczne. */
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const {spawn}=require('child_process'),{once}=require('events');
const {WebSocketServer}=require('../app/node_modules/ws');
const {JSDOM,ResourceLoader,VirtualConsole}=require('../app/node_modules/jsdom');
const F=require('./ami-fixture'),{M,D}=F;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ami-http-')),app=path.resolve(__dirname,'../app'),pub=path.join(app,'public');
const dataFile=path.join(temp,'kv-store.json');let server,ws,base,mode='ok',passed=0,failed=0,activeDom;
const messages=[];let logs='';
async function test(name,fn){try{await fn();passed++;console.log('  ✓ '+name);}catch(e){failed++;console.error('  ✗ '+name+'\n'+e.stack);}}
async function until(fn,label='warunek',ms=6000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('Timeout '+label);await new Promise(r=>setTimeout(r,10));}}
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function req(route,body){const r=await fetch(base+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return {r,j:await r.json()};}
const seed=()=>fs.writeFileSync(dataFile,JSON.stringify({'pv-sim-v1-demo':'keep','unrelated':'keep'}));
const raw=()=>fs.existsSync(dataFile)?fs.readFileSync(dataFile,'utf8'):null;
const context=async()=> (await req('/api/ami/context')).j;
async function read(from='2026-10-01',through=from,meter=F.meter){return req('/api/ami/read',{meter,from,through});}
async function commit(c,p,more={}){return req('/api/ami/commit',{revision:c.revision,receipts:[p.receipt],confirmMeter:true,...more});}
async function openDom(){
 const calls=[],errors=[],control={readError:false,html:false,hold:false};
 const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 class Local extends ResourceLoader{fetch(url){const u=new URL(url);if(u.host!=='ami.test')return Promise.resolve(Buffer.from(''));const file=path.join(pub,u.pathname.replace('/ingress-demo/',''));if(!file.startsWith(pub)||!fs.existsSync(file))throw Error('asset '+url);return Promise.resolve(fs.readFileSync(file));}}
 const dom=new JSDOM(fs.readFileSync(path.join(pub,'index.html'),'utf8'),{url:'https://ami.test/ingress-demo/',runScripts:'dangerously',resources:new Local(),virtualConsole:vc,beforeParse(w){
  w.AbortController=AbortController;w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
  w.fetch=async(input,opts={})=>{
   const u=new URL(String(input),w.location.href);assert.ok(u.pathname.startsWith('/ingress-demo/'),'ingress relative URL');
   const api=u.pathname.replace('/ingress-demo','')+u.search;calls.push({api,method:opts.method||'GET'});
   if(api.startsWith('/api/growatt/')||api.startsWith('/api/pv/stats'))return new Response(JSON.stringify({error:'synthetic unavailable'}),{status:404});
   if(api==='/api/ami/read'){
    if(control.readError)return new Response(JSON.stringify({error:'synthetic HA offline'}),{status:502});
    if(control.html)return new Response('<html>HA SPA</html>',{status:200});
    if(control.hold)return new Promise((resolve,reject)=>{opts.signal.addEventListener('abort',()=>{const e=Error('aborted');e.name='AbortError';reject(e);},{once:true});});
   }
   return fetch(base+api,opts);
  };
 }});
 activeDom=dom;await until(()=>dom.window.G13AmiBridge,'bridge');await dom.window.G13AmiBridge.whenReady;await new Promise(r=>setTimeout(r,40));
 return {dom,w:dom.window,$:id=>dom.window.document.getElementById(id),calls,errors,control};
}
async function click(d){d.$('btnAmiFetch').click();await until(()=>!d.$('btnAmiCancel').hidden||d.$('amiStatus').textContent.includes('Poczekaj'),'start');await until(()=>d.$('btnAmiCancel').hidden,'finish',15000);}
async function setup(d,from='2026-10-01') {await click(d);d.$('amiMeter').value=F.meter;d.$('amiConfirm').checked=true;d.$('amiFrom').value=from;}
(async()=>{
 ws=new WebSocketServer({port:0,host:'127.0.0.1'});await once(ws,'listening');
 ws.on('connection',client=>{
  client.send(JSON.stringify({type:'auth_required'}));client.on('message',raw=>{
   const q=JSON.parse(raw);
   if(q.type==='auth'){client.send(JSON.stringify({type:mode==='auth-invalid'?'auth_invalid':'auth_ok'}));return;}
   messages.push(q);
   if(q.type==='recorder/list_statistic_ids'){
    let md=F.fixture().metadata;
    if(mode==='two-meters')md=md.concat(F.fixture('2026-10-01','2026-10-01','synthetic_meter_b').metadata);
    if(mode==='no-balanced')md=md.filter(x=>!x.statistic_id.endsWith('_balanced_generation'));
    if(mode==='unit-display-only')md.forEach(x=>delete x.statistics_unit_of_measurement);
    if(mode==='Wh')md.forEach(x=>x.statistics_unit_of_measurement='Wh');
    client.send(JSON.stringify({id:q.id,type:'result',success:mode!=='metadata-error',result:mode==='bad-metadata'?{}:md}));return;
   }
   if(q.type==='recorder/statistics_during_period'){
    if(mode==='disconnect'){client.close();return;}
    const from=D.localKey(Date.parse(q.start_time)+M.HOUR).slice(0,10),through=D.localKey(Date.parse(q.end_time)-M.HOUR).slice(0,10);
    const meter=q.statistic_ids[0].includes('synthetic_meter_b')?'synthetic_meter_b':F.meter;
    const f=F.fixture(from,through,meter);let data=f.series;
    if(mode==='Wh' && (!q.units||q.units.energy!=='kWh'))for(const rows of Object.values(data))for(const r of rows){r.state*=1000;r.sum*=1000;}
    if(mode==='missing-hour')data[f.group.totals.balanced_consumption].splice(13,1);
    if(mode==='empty'||mode==='empty-first'&&through<M.yesterday())data={};
    if(mode==='missing-end')for(const id of Object.keys(data))data[id]=data[id].filter(x=>x.start<Date.parse(q.end_time)-24*M.HOUR);
    if(mode==='extra-id')data['sensor.unrequested']=[{start:0,state:999,sum:999}];
    if(mode==='duplicate')data[f.group.totals.balanced_consumption].push(data[f.group.totals.balanced_consumption][1]);
    client.send(JSON.stringify({id:q.id,type:'result',success:mode!=='statistics-error'&&!(mode==='fail-last'&&through===M.yesterday()),result:data}));return;
   }
   client.send(JSON.stringify({id:q.id,type:'result',success:false,error:{message:'synthetic unknown request'}}));
  });
 });
 const p=await port();base='http://127.0.0.1:'+p;fs.writeFileSync(path.join(temp,'options.json'),JSON.stringify({growatt_entities:[],history_months_back:1}));seed();
 server=spawn(process.execPath,['server.js'],{cwd:app,env:{...process.env,PORT:String(p),DATA_DIR:temp,OPTIONS_FILE:path.join(temp,'options.json'),HA_WS_URL:'ws://127.0.0.1:'+ws.address().port,SUPERVISOR_TOKEN:'synthetic-token-not-secret',ADDON_TOKEN:''},stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
 await until(()=>logs.includes('nasłuchuje'),'HTTPstartup');
 await test('AH01 discovery jesttylkoodczytem, unitkWh, braknumerów hardcoded',async()=>{const before=raw(),{r,j}=await req('/api/ami/meters');assert.equal(r.status,200);assert.equal(j.meters.length,1);assert.equal(j.meters[0].ready,true);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(raw(),before);assert.equal(messages.at(-1).statistic_type,'sum');});
 await test('AH02 readWSżądastate/sum, bufor1h i jawnekWh',async()=>{const before=raw(),{r,j}=await read();assert.equal(r.status,200);assert.equal(j.rows.length,24);const q=messages.at(-1);assert.deepEqual(q.types,['state','sum']);assert.deepEqual(q.units,{energy:'kWh'});assert.equal(q.period,'hour');assert.equal(q.start_time,new Date(D.range('2026-10-01','2026-10-01').start-M.HOUR).toISOString());assert.equal(raw(),before);});
 await test('AH03 Whmetadane znormalizowanejedenraz',async()=>{mode='Wh';const {j}=await read();assert.equal(j.rows.find(x=>x.hour===12).oddaniePoZbil,1.5);mode='ok';});
 for(const bad of [null,{},[],{meter:'<script>',from:'2026-10-01',through:'2026-10-01'},{meter:F.meter,from:'2026-02-30',through:'2026-03-01'},{meter:F.meter,from:'2026-01-01',through:'2026-03-01'},{meter:F.meter,from:'2099-01-01',through:'2099-01-02'}])await test('AH04 zływniosek400przedHA '+JSON.stringify(bad),async()=>{const n=messages.length;const {r}=await req('/api/ami/read',bad||{invalid:true});assert.equal(r.status,400);assert.equal(messages.length,n);});
 for(const kind of ['auth-invalid','metadata-error','bad-metadata','no-balanced','unit-display-only','statistics-error','disconnect','duplicate'])await test('AH05 błądźródła'+kind+'bezusuwaniahistorii',async()=>{const before=raw();mode=kind;const {r,j}=await read();assert.equal(r.status,502);assert.equal(raw(),before);assert.ok(!j.error.includes(F.meter));mode='ok';});
 await test('AH06 brakgodzin nie wypełnianyzerem',async()=>{mode='missing-hour';const {j}=await read();assert.equal(j.rows.length,22);assert.equal(j.diagnostics.omittedHours,2);mode='ok';});
 await test('AH07 cała pustaczęśćbezfałszywejenergii',async()=>{mode='empty';const {j}=await read();assert.equal(j.rows.length,0);assert.equal(j.diagnostics.omittedHours,24);mode='ok';});
 await test('AH08 niezamówionestatystyki ignorowane',async()=>{mode='extra-id';const {j}=await read();assert.equal(j.rows.length,24);mode='ok';});
 await test('AH09 jesiennyDSTnieduplikowany, CSVfallback',async()=>{const {j}=await read('2026-10-25');assert.equal(j.diagnostics.expectedHours,25);assert.equal(j.diagnostics.reasons.dst,2);assert.equal(j.rows.length,23);});
 await test('AH10 pierwszezapisypotwierdzane; brakmożliwościwstrzyknięciawierszy',async()=>{seed();const c=await context(),p=(await read()).j;const before=raw();const no=await commit(c,p,{confirmMeter:false});assert.equal(no.r.status,400);assert.equal(raw(),before);const ok=await commit(c,p,{rows:[{fake:999}]});assert.equal(ok.r.status,200);assert.equal(ok.j.added.length,24);assert.equal(Object.keys(JSON.parse(JSON.parse(raw())['elicznik-hourly-2026-10'])).length,24);assert.equal(JSON.parse(raw())['pv-sim-v1-demo'],'keep');});
 await test('AH11 ponownekliknięciebezpodwójnegoliczenia/beznowegozapisu',async()=>{const before=raw(),c=await context(),p=(await read()).j;const {r,j}=await commit(c,p,{confirmMeter:false});assert.equal(r.status,200);assert.equal(j.added.length,0);assert.equal(j.equal.length,24);assert.equal(raw(),before);});
 await test('AH12 zużytypotwierdzonyodczytniepowtarzazapisu',async()=>{const c=await context(),p=(await read()).j;await commit(c,p);const before=raw();assert.equal((await commit(c,p)).r.status,400);assert.equal(raw(),before);});
 await test('AH13 zmianaKVwinnejkarcie =>409 beznadpisania',async()=>{const c=await context(),p=(await read('2026-10-02')).j;await fetch(base+'/api/kv/other',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({value:'keep concurrent'})});const before=raw();assert.equal((await commit(c,p)).r.status,409);assert.equal(raw(),before);});
 await test('AH14 receipt różnychliczników niełączy',async()=>{mode='two-meters';const c=await context(),a=(await read()).j,b=(await read('2026-10-02','2026-10-02','synthetic_meter_b')).j;const before=raw();const {r}=await req('/api/ami/commit',{revision:c.revision,receipts:[a.receipt,b.receipt],confirmMeter:true});assert.equal(r.status,400);assert.equal(raw(),before);mode='ok';});
 await test('AH15 nieciągłe/mieszane/duplikatyodczytówbezczęściowegoimportu',async()=>{const c=await context(),a=(await read()).j,b=(await read('2026-10-03')).j,before=raw();for(const rs of [[a.receipt,a.receipt],[a.receipt,b.receipt],['unknown']]){const {r}=await req('/api/ami/commit',{revision:c.revision,receipts:rs,confirmMeter:true});assert.equal(r.status,400);}assert.equal(raw(),before);});
 await test('AH16 uszkodzonyzapisbezresetucontext503',async()=>{const before=raw();fs.writeFileSync(dataFile,'{broken');assert.equal((await req('/api/ami/context')).r.status,503);assert.equal(raw(),'{broken');fs.writeFileSync(dataFile,before);});
 await test('AH17 zasobywHTMLhashowane i staryeksportniepoluzowany',async()=>{const html=await(await fetch(base+'/')).text();for(const n of ['ami-model.js','ami-ui.js'])assert.ok(new RegExp(n+'\\?v=\\d+').test(html));const r=await fetch(base+'/api/ha/stats.csv?entities='+encodeURIComponent('tauron_importer:'+F.meter+'_consumption'));assert.equal(r.status,400);});
 await test('AH18 żądaniaHAwyłącznieodczyt: brakservice/import/metadatawrites',async()=>{assert.ok(messages.every(q=>['recorder/list_statistic_ids','recorder/statistics_during_period'].includes(q.type)));assert.ok(!logs.includes('synthetic-token-not-secret'));assert.ok(!logs.includes(F.meter));});
 // Complete user flow from real HTML served with relative ingress resources.
 seed();let d=await openDom();
 await test('AD01 wejście/ready nie wywołujeAMI iniepiszeKV',async()=>{assert.equal(d.calls.filter(c=>c.api.startsWith('/api/ami')).length,0);assert.ok(d.$('fileElicznik'));assert.ok(d.$('btnAmiFetch'));assert.equal(d.errors.length,0);});
 await test('AD02 pierwszekliknięcie: lokalnywybór bezwymaganiaPPEwrozmowie',async()=>{const before=raw();await setup(d);assert.equal(d.$('amiSettings').hidden,false);assert.equal(raw(),before);assert.equal(d.calls.filter(c=>c.api==='/api/ami/read').length,0);});
 await test('AD03 pełnyprzycisk: nowegodziny, źródłowPV, brakkosztów iPVwrites',async()=>{d.$('amiFrom').value=M.yesterday();const pvBefore=JSON.parse(raw())['pv-sim-v1-demo'];await click(d);assert.ok(d.$('amiStatus').textContent.includes('Dodano 24 godzin'),d.$('amiStatus').textContent);assert.equal(Object.keys(d.w.G13PvReadOnly.getSnapshot().hourlyElicznik).length,24);assert.equal(JSON.parse(raw())['pv-sim-v1-demo'],pvBefore);assert.equal(d.$('fileElicznik').disabled,false);assert.ok(d.calls.some(c=>c.api==='/api/ami/commit'));assert.equal(d.errors.length,0);});
 await test('AD04 drugiekliknięcie bezpotwierdzenia importuje0bezKVwrite',async()=>{const before=raw();d.$('amiConfirm').checked=false;await click(d);assert.ok(d.$('amiStatus').textContent.includes('Dodano 0 godzin'));assert.equal(raw(),before);});
 await test('AD05 HTTPerror iHTML niezmieniająhistoriianirejestru',async()=>{for(const flag of ['readError','html']){d.control[flag]=true;const before=raw(),view=JSON.stringify(d.w.G13PvReadOnly.getSnapshot());await click(d);assert.equal(raw(),before);assert.equal(JSON.stringify(d.w.G13PvReadOnly.getSnapshot()),view);assert.equal(d.$('fileElicznik').disabled,false);d.control[flag]=false;}});
 await test('AD06 anulowanieodczytu zachowujestani przywracaCSV',async()=>{const before=raw();d.control.hold=true;d.$('btnAmiFetch').click();await until(()=>d.$('amiStatus').textContent.startsWith('Pobieram AMIplus'));await until(()=>!d.$('btnAmiCancel').disabled);d.$('btnAmiCancel').click();await until(()=>d.$('btnAmiCancel').hidden);assert.equal(raw(),before);assert.ok(d.$('amiStatus').textContent.includes('Anulowano'));assert.equal(d.$('fileElicznik').disabled,false);d.control.hold=false;});
 await test('AD07 ręcznyCSV nadal działa po błędzieAMI',async()=>{const date=M.dayShift(M.yesterday(),-2),csv='Data;Strefa;Wartość;Rodzaj;Status\n'+date+' 24:00;T3;0,777;pobrana po zbilansowaniu [kWh];licznik\n'+date+' 24:00;T3;0,222;oddana po zbilansowaniu [kWh];licznik';Object.defineProperty(d.$('fileElicznik'),'files',{configurable:true,value:[{name:'synthetic.csv',text:async()=>csv}]});d.$('fileElicznik').dispatchEvent(new d.w.Event('change'));await until(()=>d.w.G13PvReadOnly.getSnapshot().hourlyElicznik[date+'_23']);await until(()=>JSON.stringify(raw()).includes('0.777'));const row=d.w.G13PvReadOnly.getSnapshot().hourlyElicznik[date+'_23'];assert.equal(row.poborPoZbil,.777);assert.equal(row.oddaniePoZbil,.222);});
 d.dom.window.close();activeDom=null;
 await test('AD08 restartodtwarzazapisAMI i ręcznyCSVbezautopobierania',async()=>{d=await openDom();assert.equal(Object.keys(d.w.G13PvReadOnly.getSnapshot().hourlyElicznik).length,25);assert.equal(d.calls.filter(c=>c.api.startsWith('/api/ami')).length,0);d.dom.window.close();activeDom=null;});
 await test('AD09 częściowazgodnośćCSV:konfliktpozostaje, resztanowe',async()=>{const end=M.yesterday(),f=F.fixture(end),rows=F.normalize(f).rows,old={...rows[0],poborPoZbil:99};delete old.key;const kv={['elicznik-hourly-'+end.slice(0,7)]:JSON.stringify({[rows[0].key]:old}),'monthly-ledger':JSON.stringify({months:{[end.slice(0,7)]:{kosztEnergii:17,kosztDystrybucji:8}}})};fs.writeFileSync(dataFile,JSON.stringify(kv));d=await openDom();await setup(d,end);await click(d);assert.ok(d.$('amiStatus').textContent.includes('Dodano 23 godzin'));assert.equal(d.w.G13PvReadOnly.getSnapshot().hourlyElicznik[rows[0].key].poborPoZbil,99);const ledger=JSON.parse(JSON.parse(raw())['monthly-ledger']);assert.equal(ledger.months[end.slice(0,7)].kosztEnergii,17);assert.equal(ledger.months[end.slice(0,7)].kosztDystrybucji,8);d.dom.window.close();activeDom=null;});
 await test('AD10 pustapierwszaczęśćnieblokujepóźniejszychdanych',async()=>{seed();mode='empty-first';d=await openDom();await setup(d,M.dayShift(M.yesterday(),-31));await click(d);assert.ok(d.$('amiStatus').textContent.includes('Dodano 24 godzin'),d.$('amiStatus').textContent);assert.equal(Object.keys(d.w.G13PvReadOnly.getSnapshot().hourlyElicznik).length,24);d.dom.window.close();activeDom=null;mode='ok';});
 await test('AD11 awariaostatniejczęściniezapisujewcześniejszych',async()=>{seed();mode='fail-last';d=await openDom();await setup(d,M.dayShift(M.yesterday(),-31));const before=raw();await click(d);assert.equal(raw(),before);assert.equal(Object.keys(d.w.G13PvReadOnly.getSnapshot().hourlyElicznik).length,0);assert.equal(d.$('fileElicznik').disabled,false);d.dom.window.close();activeDom=null;mode='ok';});
 await test('AD12 wybórinnegolicznikaniejestpoCichuzastępowanystarym',async()=>{seed();mode='two-meters';d=await openDom();await setup(d,M.yesterday());await click(d);const before=raw(),n=d.calls.filter(c=>c.api==='/api/ami/read').length;d.$('amiMeter').value='synthetic_meter_b';await click(d);assert.equal(raw(),before);assert.equal(d.calls.filter(c=>c.api==='/api/ami/read').length,n);assert.ok(d.$('amiStatus').textContent.includes('inny licznik'));assert.equal(d.$('amiMeter').value,'synthetic_meter_b');d.dom.window.close();activeDom=null;mode='ok';});
 console.log('\n'+passed+' przeszło, '+failed+' nie przeszło');
})().catch(e=>{failed++;console.error(e.stack);}).finally(async()=>{if(activeDom)activeDom.window.close();if(server){server.kill('SIGTERM');await once(server,'exit').catch(()=>{});}if(ws){for(const c of ws.clients)c.terminate();await new Promise(r=>ws.close(r));}fs.rmSync(temp,{recursive:true,force:true});process.exitCode=failed?1:0;});
