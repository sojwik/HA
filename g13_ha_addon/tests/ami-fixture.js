'use strict';
const D=require('../app/public/pv-data'),M=require('../app/public/ami-model');
const meter='synthetic_meter_a';
const names={1:'Szczyt przedpołudniowy',2:'Szczyt popołudniowy',3:'Reszta dnia (w tym weekendy)'};
function fixture(from='2026-10-01',through=from,meterName=meter){
  const metadata=[],series={},r=D.range(from,through);
  for(const channel of M.fields)for(const zone of [null,1,2,3]){
    const id='tauron_importer:'+meterName+'_'+channel+(zone?'_zone_'+zone:'');
    metadata.push({statistic_id:id,source:'tauron_importer',name:'Tauron AMIplus DEMO '+channel.replace('_',' ')+(zone?' '+names[zone]:''),has_sum:true,unit_class:'energy',statistics_unit_of_measurement:'kWh',display_unit_of_measurement:'Wh'});
    const rows=[];let sum=100;
    for(let ts=r.start-M.HOUR;ts<r.end;ts+=M.HOUR){
      const hour=Number(D.localKey(ts).slice(-2));const activeZone=hour>=7&&hour<13?1:hour>=16&&hour<21?2:3;
      const imp=hour<7?0.1:hour>=16?0.2:0,exp=hour>=8&&hour<16?1.5:0;
      const raw={balanced_consumption:imp,balanced_generation:exp,consumption:imp+0.05,generation:exp+0.05}[channel];
      const state=zone&&zone!==activeZone?0:raw;sum+=state;
      rows.push({start:ts,end:ts+M.HOUR,state,sum});
    }
    series[id]=rows;
  }
  const group=M.discover(metadata)[0];return {from,through,meter:meterName,metadata,series,group,r};
}
const clone=x=>JSON.parse(JSON.stringify(x));
function normalize(f){return M.normalize(f.group,f.series,f.from,f.through);}
module.exports={fixture,clone,normalize,meter,D,M};
