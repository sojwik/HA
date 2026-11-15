/* Przycisk AMI działa wyłącznie na żądanie. Nie ma timera ani pobierania przy wejściu. */
(function () {
  'use strict';
  const M=window.G13AmiModel,B=window.G13AmiBridge;
  if(!M||!B)return;
  const $=id=>document.getElementById(id),button=$('btnAmiFetch'),cancel=$('btnAmiCancel');
  const meter=$('amiMeter'),confirm=$('amiConfirm'),from=$('amiFrom'),status=$('amiStatus');
  let loaded=false,active=false,controller=null,binding=null;
  const say=(text,kind='info')=>{status.textContent=text;status.style.color=kind==='error'?'#b91c1c':kind==='warn'?'#b45309':'';};
  async function json(url,body) {
    const response=await fetch(url,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:controller.signal});
    let data;try{data=await response.json();}catch(e){throw Error('Odpowiedź nie jest danymi AMIplus (możliwy HTML lub błąd połączenia).');}
    if(!response.ok)throw Error(data&&typeof data.error==='string'?data.error:'Błąd odczytu/zapisu AMIplus.');
    if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Nieprawidłowa odpowiedź AMIplus.');
    return data;
  }
  function report(parts,imported) {
    const d=parts.reduce((s,p)=>{s.expected+=p.diagnostics.expectedHours;s.accepted+=p.rows.length;s.omitted+=p.diagnostics.omittedHours;s.unknown+=p.diagnostics.unknownZoneHours;return s;},{expected:0,accepted:0,omitted:0,unknown:0});
    const rows=parts.flatMap(p=>p.rows),last=rows.length?rows.at(-1).key.replace('_',' ')+':00':'brak';
    const complete=parts.map(p=>p.diagnostics.lastCompleteDay).filter(Boolean).sort().at(-1)||'brak';
    const base='Dodano '+imported.added.length+' godzin; zgodne już zapisane: '+imported.equal.length+'; rozbieżne/niepełne istniejące (bez nadpisania): '+imported.conflicts.length+'. '
      +'Dostępne '+d.accepted+'/'+d.expected+' h; pominięte '+d.omitted+' h; bez ustalonej strefy '+d.unknown+' h. Ostatnia dostępna godzina: '+last+'. Ostatnia pełna doba w odczycie: '+complete+'. '
      +'Cel: '+parts.at(-1).through+' (D−1), nie gwarancja dostępności. Brakujące ceny pobierz osobno przyciskiem RCE.';
    say(base,d.omitted||imported.conflicts.length?'warn':'info');
    const list=$('amiDetails');list.replaceChildren();
    const reasons={};for(const p of parts)for(const [k,v]of Object.entries(p.diagnostics.reasons||{}))reasons[k]=(reasons[k]||0)+v;
    for(const [k,v]of Object.entries(reasons)){const li=document.createElement('li');li.textContent=k+': '+v+' h';list.appendChild(li);}
    if(imported.conflicts.length){const li=document.createElement('li');li.textContent='Zachowano istniejące wpisy: '+imported.conflicts.slice(0,20).join(', ')+(imported.conflicts.length>20?' …':'');list.appendChild(li);}
  }
  async function run() {
    if(active)return;active=true;controller=new AbortController();let guard=null,commitStarted=false;
    try {
      await B.whenReady;guard=B.begin();cancel.disabled=false;cancel.hidden=false;
      const context=await json('api/ami/context');
      const view=B.getSnapshot();
      if(M.stable(view.hourlyElicznik)!==M.stable(context.hourly)||M.stable(view.rceHourly)!==M.stable(context.rceHourly))
        throw Error('Widok i zapisane dane różnią się. Odśwież stronę dodatku przed importem; niczego nie nadpisano.');
      binding=context.binding;
      const discovered=await json('api/ami/meters');
      if(discovered.kind!=='ami_meters_v1'||!Array.isArray(discovered.meters))throw Error('Nieprawidłowa lista liczników.');
      const groups=discovered.meters.filter(x=>x.ready===true);
      if(!groups.length)throw Error('Brak gotowych statystyk tauron_importer z osobnym poborem i oddaniem po bilansowaniu. Użyj CSV/XLSX.');
      const selected=meter.value;
      meter.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent='Wybierz swój licznik lokalnie';meter.appendChild(empty);
      for(const g of groups){const opt=document.createElement('option');opt.value=g.meter;opt.textContent=g.label||'Licznik AMIplus';meter.appendChild(opt);}
      meter.value=selected||(binding?binding.meter:'');
      if(binding&&!groups.some(g=>g.meter===binding.meter))throw Error('Zapisany licznik AMI nie jest dostępny. Nie wybrano zastępczego; import CSV/XLSX pozostaje dostępny.');
      if(!from.value)from.value=M.defaultFrom(context.hourly,discovered.through);
      $('amiThrough').textContent=discovered.through+' (wczoraj, Europe/Warsaw)';from.max=discovered.through;
      $('amiSettings').hidden=false;
      if(!loaded&&!binding || !meter.value || !binding&&!confirm.checked){
        loaded=true;say('Wykryto AMIplus. Wybierz licznik, sprawdź datę „Od” i potwierdź, że to licznik tych danych. Następnie kliknij ponownie „Pobierz dane z AMIplus”. Nie potrzebujesz podawać numeru w rozmowie.');return;
      }
      loaded=true;
      if(binding&&binding.meter!==meter.value)throw Error('Wybrano inny licznik niż wcześniej. Nie łączymy danych różnych liczników.');
      M.span(from.value,discovered.through);
      const ranges=M.chunks(from.value,discovered.through),parts=[];
      for(let i=0;i<ranges.length;i++){
        say('Pobieram AMIplus: '+ranges[i][0]+' – '+ranges[i][1]+' ('+(i+1)+'/'+ranges.length+'). Jeszcze niczego nie zapisano.');
        const p=await json('api/ami/read',{meter:meter.value,from:ranges[i][0],through:ranges[i][1]});
        if(p.kind!=='ami_hourly_v1'||p.from!==ranges[i][0]||p.through!==ranges[i][1]||!Array.isArray(p.rows)||!p.diagnostics||typeof p.receipt!=='string')throw Error('Nieprawidłowa część historii AMIplus.');
        for(const r of p.rows)M.validateRow(r);parts.push(p);
      }
      if(B.guard()!==guard)throw Error('Dane widoku zmieniły się. Nie zapisano importu.');
      const preview=M.merge(view.hourlyElicznik,parts.flatMap(p=>p.rows));
      if(!preview.added.length){report(parts,{added:[],equal:preview.equal,conflicts:preview.conflicts});return;}
      cancel.disabled=true;commitStarted=true;say('Zapisuję wyłącznie nowe godziny. Istniejące dane pozostają bez zmian…');
      const imported=await json('api/ami/commit',{revision:context.revision,receipts:parts.map(p=>p.receipt),confirmMeter:!!binding||confirm.checked});
      B.apply(imported,guard);binding=imported.binding;report(parts,imported);
    } catch(e) {
      say(e.name==='AbortError'?'Anulowano pobieranie. Nie zapisano danych.':(commitStarted?'Nie potwierdzono pełnego zakończenia operacji. Odśwież widok przed następną próbą; ponowny import nie dolicza godzin drugi raz. ':'Nie pobrano nowych danych. Import CSV/XLSX nadal jest dostępny. ')+e.message,'error');
    } finally {
      if(guard!==null)B.end();cancel.hidden=true;cancel.disabled=true;active=false;controller=null;
    }
  }
  cancel.addEventListener('click',()=>{if(controller&&!cancel.disabled)controller.abort();});
  button.addEventListener('click',run);
  // Jeden formularz, jeden wybór licznika i jeden handler — bez kopii importu.
  // Przenosimy istniejący DOM, nie klonujemy kontrolek ani nie pobieramy na wejściu.
  const panel=$('amiPanel'),home=$('amiHome'),pv=$('pvAmiMount');
  if(panel&&home&&pv){
    const place=()=>{const destination=$('tab-pv').hidden?home:pv;if(panel.parentElement!==destination)destination.append(panel);};
    document.querySelectorAll('.tab-btn').forEach(tab=>tab.addEventListener('click',place));
    place();
  }
  B.whenReady.then(()=>{const end=M.yesterday();from.value=M.defaultFrom(B.getSnapshot().hourlyElicznik,end);$('amiThrough').textContent=end+' (wczoraj, Europe/Warsaw)';});
})();
