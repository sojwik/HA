/* AMIplus: tylko nowe wejście eLicznika. Żadne zastępowanie PV ani naprawa HA.
 * tauron_importer zapisuje state=energia godziny, sum=narastająca suma.
 * Używamy state z kontrolą sąsiedniego sum, nigdy mean ani sum jako kWh/h. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pv-data'));
  else root.G13AmiModel = factory(root.G13PvData);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (D) {
  'use strict';
  const HOUR = 3600000, EPS = 1e-6;
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const fields = ['balanced_consumption', 'balanced_generation', 'consumption', 'generation'];
  const reasonLabels = { missing: 'brak godziny/kanału', invalid: 'nieprawidłowa energia lub suma',
    buffer: 'brak sąsiedniej sumy do kontroli', inconsistent: 'energia godziny nie zgadza się z przyrostem sumy',
    zone: 'sprzeczny podział na strefy', dst: 'powtórzona godzina DST — pozostaw CSV' };
  function fail(message) { throw new Error(message); }
  function stable(x) {
    if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
    if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}';
    return JSON.stringify(x);
  }
  function validDate(date) {
    return typeof date==='string' && /^20\d{2}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date+'T00:00:00Z'))
      && new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
  }
  function dayShift(date, n) {
    if (!validDate(date) || !Number.isInteger(n)) fail('Nieprawidłowa data.');
    return new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  }
  function yesterday(now = Date.now()) { return dayShift(D.localKey(now).slice(0, 10), -1); }
  function span(from, through, now = Date.now(), maxDays = 366) {
    const r = D.range(from, through);
    if (through > yesterday(now)) fail('AMIplus: koniec zakresu może być najpóźniej wczoraj (D−1, Europe/Warsaw).');
    if (Date.parse(through) - Date.parse(from) > (maxDays - 1) * 86400000) fail('Zbyt długi zakres AMIplus.');
    return r;
  }
  function defaultFrom(grid, end) {
    const dates = Object.keys(grid || {}).filter(k => /^20\d{2}-\d{2}-\d{2}_\d{2}$/.test(k) && k.slice(0, 10) <= end).sort();
    return dates.length ? dayShift(dates.at(-1).slice(0, 10), -6) : dayShift(end, -30);
  }
  function chunks(from, end) {
    const out = [];
    if (!validDate(from) || !validDate(end) || from > end) fail('Nieprawidłowy zakres AMIplus.');
    for (let d = from; d <= end;) { const through = dayShift(d, 30) < end ? dayShift(d, 30) : end; out.push([d, through]); d = dayShift(through, 1); }
    return out;
  }
  function splitId(id) {
    const m = typeof id === 'string' && /^tauron_importer:([a-z0-9_]{1,160}?)_(balanced_consumption|balanced_generation|consumption|generation)(?:_zone_([a-z0-9]{1,16}))?$/.exec(id);
    return m ? { meter: m[1], channel: m[2], zone: m[3] || null } : null;
  }
  function validMetadata(m) {
    if (!m || m.source !== 'tauron_importer' || m.has_sum !== true) return false;
    if (m.unit_class !== undefined && m.unit_class !== null && m.unit_class !== 'energy') return false;
    const modern = own(m, 'statistics_unit_of_measurement');
    const unit = modern ? m.statistics_unit_of_measurement : m.unit_of_measurement;
    if (!['Wh', 'kWh'].includes(unit)) return false;
    return !(modern && own(m, 'unit_of_measurement') && m.unit_of_measurement !== unit);
  }
  function zoneName(name, channel) {
    const text = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').toLowerCase();
    const pos = text.lastIndexOf(channel.replace('_', ' ') + ' ');
    if (pos < 0) return null;
    const suffix = text.slice(pos + channel.length + 1);
    if (/^szczyt przedpoludniowy(?:\b|$)/.test(suffix)) return 'T1';
    if (/^szczyt popoludniowy(?:\b|$)/.test(suffix)) return 'T2';
    if (/^reszta dnia(?:\b|$)/.test(suffix)) return 'T3';
    return null; // Nie zgadujemy taryfy po numerze zone_N.
  }
  function discover(metadata) {
    if (!Array.isArray(metadata)) fail('HA nie zwrócił listy metadanych statystyk.');
    const groups = new Map(), seen = new Set();
    for (const m of metadata) {
      const p = splitId(m && m.statistic_id); if (!p) continue;
      if (!groups.has(p.meter)) groups.set(p.meter, { meter: p.meter, label: '', totals: {}, zones: {}, problems: [] });
      const g = groups.get(p.meter);
      if (seen.has(m.statistic_id)) { g.problems.push('Powtórzona definicja statystyki.'); continue; }
      seen.add(m.statistic_id);
      if (!validMetadata(m)) { g.problems.push('Niepotwierdzona jednostka energii lub rodzaj statystyki.'); continue; }
      if (!p.zone) {
        g.totals[p.channel] = m.statistic_id;
        if (!g.label) g.label = String(m.name || 'Licznik AMIplus').replace(new RegExp(' ' + p.channel.replace('_', ' ') + '$', 'i'), '').slice(0, 160);
      } else {
        (g.zones[p.channel] = g.zones[p.channel] || []).push({ id: m.statistic_id, zone: zoneName(m.name, p.channel) });
      }
    }
    return Array.from(groups.values()).sort((a,b) => a.meter.localeCompare(b.meter)).map(g => {
      g.ready = !!g.totals.balanced_consumption && !!g.totals.balanced_generation && !g.problems.length;
      if (!g.totals.balanced_consumption || !g.totals.balanced_generation) g.problems.push('Brak osobnego poboru lub oddania po bilansowaniu.');
      g.ids = fields.flatMap(f => [g.totals[f], ...(g.zones[f] || []).map(z => z.id)]).filter(Boolean);
      if (g.ids.length > 40) { g.ready = false; g.problems.push('Zbyt wiele kanałów jednego licznika.'); }
      return g;
    });
  }
  function timestamp(value) {
    let ts = null;
    if (finite(value)) ts = value > 1e11 ? value : value * 1000;
    else if (typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) ts = Date.parse(value);
    return finite(ts) && ts % HOUR === 0 ? ts : null;
  }
  function normalize(group, result, from, through) {
    if (!group || !group.ready || !result || typeof result !== 'object' || Array.isArray(result)) fail('Nieprawidłowa odpowiedź AMIplus.');
    const r = D.range(from, through), maps = {};
    for (const id of group.ids) {
      const records = own(result,id) ? result[id] : [];
      if (!Array.isArray(records) || records.length > 18000) fail('Nieprawidłowe rekordy AMIplus.');
      const map = new Map();
      for (const row of records) {
        const ts = row && timestamp(row.start);
        if (ts === null || ts < r.start - HOUR || ts >= r.end) fail('Nieprawidłowa godzina w odpowiedzi HA.');
        if (map.has(ts)) fail('Powtórzona godzina UTC w odpowiedzi HA.');
        if (row.end !== undefined && timestamp(row.end) !== ts + HOUR) fail('Statystyka AMIplus nie ma okresu jednej godziny.');
        map.set(ts, row);
      }
      maps[id] = map;
    }
    function energy(id, ts, bufferRequired) {
      const map = maps[id], row = map && map.get(ts), prev = map && map.get(ts - HOUR);
      if (!row) return { error: 'missing' };
      if (!finite(row.state) || row.state < 0 || !finite(row.sum) || row.sum < 0) return { error: 'invalid' };
      if (!prev || !finite(prev.sum)) return bufferRequired ? { error: 'buffer' } : { value: row.state };
      if (Math.abs(row.state - (row.sum - prev.sum)) > EPS) return { error: 'inconsistent' };
      return { value: row.state };
    }
    const groups = new Map();
    for (let ts=r.start;ts<r.end;ts+=HOUR) {
      const key = D.localKey(ts); if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(ts);
    }
    const rows = [], reasons = {}, issues = [], days = {};
    function skip(key, code, hours=1) { reasons[code]=(reasons[code]||0)+hours; issues.push({ key, code, hours, message: reasonLabels[code] }); }
    for (const [key,times] of groups) {
      const date=key.slice(0,10); days[date]=days[date]||{expected:0,known:0}; days[date].expected+=times.length;
      // Starszy updater AMI może zlewać oba foldy. Bez dowodu nie twórz 2h z jednego wpisu.
      if (times.length !== 1) { skip(key,'dst',times.length); continue; }
      const ts=times[0], imp=energy(group.totals.balanced_consumption,ts,true), exp=energy(group.totals.balanced_generation,ts,true);
      if (imp.error || exp.error) { skip(key,imp.error || exp.error); continue; }
      const nonzeroZones = new Set(); let badZone=false;
      for (const channel of fields) {
        const zones=group.zones[channel] || []; if (!zones.length) continue;
        const total=energy(group.totals[channel],ts,false); if (total.error) continue;
        const zs=zones.map(z => ({ ...z, energy:energy(z.id,ts,false) }));
        if (zs.some(z => z.energy.error)) continue; // znana energia, strefa może pozostać nieznana
        if (Math.abs(zs.reduce((s,z)=>s+z.energy.value,0)-total.value)>EPS) { badZone=true; continue; }
        const active=zs.filter(z=>z.energy.value>EPS);
        if (active.length>1) badZone=true;
        for (const z of active) if (z.zone) nonzeroZones.add(z.zone);
      }
      if (badZone || nonzeroZones.size>1) { skip(key,'zone'); continue; }
      const strefa=nonzeroZones.size===1 ? Array.from(nonzeroZones)[0] : null;
      rows.push({key,date,hour:Number(key.slice(11)),oddaniePoZbil:exp.value,poborPoZbil:imp.value,strefa,
        hasImport:true,hasExport:true,importCount:1,exportCount:1,expectedCount:1,source:'AMIplus'});
      days[date].known++;
    }
    return { kind:'ami_hourly_v1', from, through, rows, diagnostics:{expectedHours:r.hours,acceptedHours:rows.length,
      omittedHours:r.hours-rows.length,unknownZoneHours:rows.filter(x=>x.strefa===null).length,
      actualFirst:rows.length?rows[0].key:null,actualLast:rows.length?rows.at(-1).key:null,
      lastCompleteDay:Object.keys(days).sort().filter(d=>days[d].known===days[d].expected).at(-1)||null,reasons,issues} };
  }
  function validateRow(row) {
    if (!row || !validDate(row.date) || !Number.isInteger(row.hour) || row.hour<0 || row.hour>23
      || row.key!==row.date+'_'+String(row.hour).padStart(2,'0') || !finite(row.poborPoZbil) || row.poborPoZbil<0
      || !finite(row.oddaniePoZbil) || row.oddaniePoZbil<0 || ![null,'T1','T2','T3'].includes(row.strefa)
      || row.hasImport!==true || row.hasExport!==true || row.importCount!==1 || row.exportCount!==1 || row.expectedCount!==1 || row.source!=='AMIplus') fail('Nieprawidłowy wiersz importu AMIplus.');
    const day=D.range(row.date,row.date); let count=0;
    for(let t=day.start;t<day.end;t+=HOUR) if(D.localKey(t)===row.key) count++;
    if(count!==1) fail('Nie importujemy niejednoznacznej lub nieistniejącej godziny lokalnej.');
    return {date:row.date,hour:row.hour,oddaniePoZbil:row.oddaniePoZbil,poborPoZbil:row.poborPoZbil,strefa:row.strefa,
      hasImport:true,hasExport:true,importCount:1,exportCount:1,expectedCount:1,source:'AMIplus'};
  }
  function merge(existing, candidates) {
    if (!Array.isArray(candidates) || candidates.length>9000) fail('Nieprawidłowa liczba godzin AMIplus.');
    const grid={...existing}, added=[], equal=[], conflicts=[], seen=new Set();
    for(const raw of candidates) {
      const row=validateRow(raw),key=raw.key;
      if(seen.has(key)) fail('Powtórzona godzina w imporcie.'); seen.add(key);
      if(!own(existing,key)) { grid[key]=row; added.push(key); continue; }
      const old=existing[key];
      if(old && old.hasImport===true && old.hasExport===true && finite(old.poborPoZbil) && finite(old.oddaniePoZbil)
        && Math.abs(old.poborPoZbil-row.poborPoZbil)<=EPS && Math.abs(old.oddaniePoZbil-row.oddaniePoZbil)<=EPS
        && (!old.strefa || !row.strefa || old.strefa===row.strefa)) equal.push(key);
      else conflicts.push(key);
      // Istniejąca godzina/flag/strefa pozostaje nietknięta, również jeśli niepełna.
    }
    return {grid,added,equal,conflicts};
  }
  return Object.freeze({HOUR,EPS,fields,stable,dayShift,yesterday,span,defaultFrom,chunks,splitId,validMetadata,discover,normalize,validateRow,merge});
});
