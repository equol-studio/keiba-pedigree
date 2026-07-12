// 函館 出走馬の血統を自動取得して pedigree-data.js を生成
// 使い方: node scrape/build-hakodate.mjs YYYYMMDD [maxRaces] [outPath]
// 依存なし（Node 18+ の標準 fetch を使用）
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function get(url){
  const res=await fetch(url,{headers:{'User-Agent':UA,'Referer':'https://race.netkeiba.com/'}});
  const buf=Buffer.from(await res.arrayBuffer());
  let txt=new TextDecoder('euc-jp').decode(buf);
  if((txt.match(/�/g)||[]).length>20) txt=buf.toString('utf8');
  return txt;
}

// blood_table(62セル DFS) → heap indexed vals
function parsePed(txt){
  const m=txt.match(/<table[^>]*blood_table[\s\S]*?<\/table>/);
  if(!m) return null;
  const tds=[...m[0].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(x=>{
    const rs=+((x[1].match(/rowspan="?(\d+)"?/)||[])[1]||'1');
    let s=(x[2].match(/<a[^>]*>([\s\S]*?)<\/a>/)||[])[1] ?? x[2];
    s=s.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
    const jp=s.match(/^[^\x00-\x7F]+/);        // 日本語名があればそれ、無ければラテン名フル
    s=jp?jp[0].trim():s.trim();
    return {rowspan:rs,name:s};
  });
  if(tds.length<62) return null;
  const vals={}; let ptr=0;
  (function build(heap,gen){
    if(ptr>=tds.length) return;
    vals[heap]=tds[ptr++].name;
    if(gen<5){ build(heap*2,gen+1); build(heap*2+1,gen+1); }
  })(2,1);
  ptr=ptr; // 父側31セル消費後、母側
  (function build(heap,gen){
    if(ptr>=tds.length) return;
    vals[heap]=tds[ptr++].name;
    if(gen<5){ build(heap*2,gen+1); build(heap*2+1,gen+1); }
  })(3,1);
  return vals;
}
function horseName(txt){
  // タイトル形式: "オウギノカナメ (Ogino Kaname) | 競走馬データ - netkeiba"
  const t=txt.match(/<title>\s*([^(（|｜]+?)\s*[(（|｜]/);
  if(t) return t[1].trim();
  const h1s=[...txt.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map(m=>m[1].replace(/<[^>]+>/g,'').trim()).filter(Boolean);
  return h1s[0]||'';
}

async function raceIdsForDate(date){
  const t=await get(`https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${date}`);
  const ids=[...new Set([...t.matchAll(/race_id=(\d{12})/g)].map(m=>m[1]))];
  return ids.filter(id=>id.slice(4,6)==='02').sort(); // 02=函館
}
async function parseRace(raceId){
  const t=await get(`https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`);
  const rd=(t.match(/<div class="RaceData01"[^>]*>([\s\S]*?)<\/div>/)||[])[1]||'';
  const sd=rd.match(/(芝|ダ|障)\s*(\d{3,4})m/);
  const surface=sd?sd[1]:''; const dist=sd?sd[2]:'';
  const course=surface?`函館${surface==='ダ'?'ダ':surface}${dist}`:'函館';
  let going=((rd.replace(/<[^>]+>/g,' ').match(/馬場[:：]\s*(不良|稍\s*重|良好|良|重|不|稍)/)||[])[1]||'').replace(/\s/g,'');
  going=({'不':'不良','稍':'稍重','良好':'良'})[going]||going;
  const rn=(t.match(/<div class="RaceName"[^>]*>([\s\S]*?)<\/div>/)||[])[1];
  const name=rn?rn.replace(/<[^>]+>/g,'').trim():'';
  const no=+raceId.slice(-2);
  const rows=[...t.matchAll(/<tr class="HorseList[\s\S]*?<\/tr>/g)];
  const byId=new Map();
  for(const r of rows){
    const seg=r[0];
    const uma=(seg.match(/<td class="Umaban[^"]*"[^>]*>\s*(\d+)/)||[])[1];
    const waku=(seg.match(/<td class="Waku[^"]*"[^>]*>[\s\S]*?>\s*(\d+)\s*</)||seg.match(/<td class="Waku(\d)/)||[])[1];
    const hid=(seg.match(/db\.netkeiba\.com\/horse\/(\d{10})/)||seg.match(/\/horse\/(\d{10})/)||[])[1];
    if(!hid) continue;
    const jockey=(seg.match(/jockey\/(?:result\/recent\/)?\d+[^>]*>([^<]+)</)||[])[1]||'';
    const trainer=(seg.match(/trainer\/(?:result\/recent\/)?\d+[^>]*>([^<]+)</)||[])[1]||'';
    const prev=byId.get(hid);
    if(!prev || (prev.umaban==null && uma)) byId.set(hid,{umaban:uma?+uma:null, waku:waku?+waku:null, horseId:hid, jockey:jockey.trim(), trainer:trainer.trim()});
  }
  const horses=[...byId.values()].sort((a,b)=>(a.umaban||99)-(b.umaban||99));
  return {raceId, no, name, course, surface, dist:+dist||null, going, horses};
}

// 前走データ：shutuba_past から全馬の前走(着順/クラス/距離/馬場/人気/上がり/通過)を1ページで取得
function parsePast(seg){
  const cell=(seg.match(/<td class="Past[^"]*"[^>]*>([\s\S]*?)<\/td>/)||[])[1];
  if(!cell) return null;
  const txt=cell.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
  const d=txt.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if(!d) return null;
  const m=txt.match(/\d{4}\.\d{1,2}\.\d{1,2}\s+(\S+?)\s+(\d+)\s/);
  const sd=txt.match(/(芝|ダ|障)(\d{3,4})/);
  const nmp=txt.match(/(\d+)頭\s+(\d+)番\s+(\d+)人/);
  return {
    date:`${d[1]}.${d[2]}.${d[3]}`, place:m?m[1]:'', chaku:m?+m[2]:null,
    surface:sd?sd[1]:'', dist:sd?+sd[2]:null,
    klass:(txt.match(/\s(G[123]|L|OP|オープン|\d勝|未勝利|新馬)\s/)||[])[1]||'',
    going:(txt.match(/(良|稍|重|不)\s+\d+頭/)||[])[1]||'',
    num:nmp?+nmp[1]:null, pop:nmp?+nmp[3]:null,
    agari:(txt.match(/\((\d{2}\.\d)\)/)||[])[1]||'',
    pass:(txt.match(/\s(\d+(?:-\d+)+)\s/)||[])[1]||''
  };
}
async function getPastMap(raceId){
  const t=await get(`https://race.netkeiba.com/race/shutuba_past.html?race_id=${raceId}`);
  const rows=[...t.matchAll(/<tr class="HorseList[\s\S]*?<\/tr>/g)];
  const map={};
  for(const r of rows){
    const hid=(r[0].match(/\/horse\/(\d{10})/)||[])[1];
    if(hid) map[hid]=parsePast(r[0]);
  }
  return map;
}

// パンダズ競馬 函館 → 種牡馬×コース×複勝回収率 を自動収集
async function scrapePandas(){
  const t=await get('https://db-keiba.com/hakodate-stallion/');
  const heads=[...t.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/g)].map(m=>m[1].replace(/<[^>]+>/g,'').trim());
  const courses=heads.filter(h=>/函館(芝|ダート)\d/.test(h)).map(h=>{
    const m=h.match(/函館(芝|ダート)(\d{3,4})/); return `函館${m[1]==='ダート'?'ダ':'芝'}${m[2]}`;
  });
  const tables=t.split('<table').slice(1).map(x=>'<table'+x.split('</table>')[0]);
  const recs=[];
  tables.forEach((tb,i)=>{
    const course=courses[i]; if(!course) return;
    const rows=[...tb.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r=>[...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c=>c[1].replace(/<[^>]+>/g,'').trim()));
    rows.forEach(cells=>{
      if(cells.length<11) return;
      const name=cells[0];
      if(!name||/種牡馬|1着|勝率/.test(name)) return;
      recs.push({sire:name, course, period:'21-25', n:cells[5], fukuRate:cells[8], tan:cells[9], fuku:cells[10], src:'パンダズ'});
    });
  });
  return recs;
}

async function main(){
  const date=process.argv[2];
  const maxRaces=process.argv[3]?+process.argv[3]:99;
  const out=process.argv[4]||fileURLToPath(new URL('../pedigree-data.js',import.meta.url));
  if(!date){ console.error('usage: node build-hakodate.mjs YYYYMMDD [maxRaces] [outPath]'); process.exit(1); }
  console.error('date',date);
  let ids=await raceIdsForDate(date);
  console.error('函館 race_ids:',ids.length);
  ids=ids.slice(0,maxRaces);
  const pedCache={};
  const races=[];
  for(const id of ids){
    const race=await parseRace(id);
    let pastMap={};
    try{ pastMap=await getPastMap(id); await sleep(300); }catch(e){ console.error('past skip',e.message); }
    console.error(`R${race.no} ${race.course} 頭数=${race.horses.length} 前走取得=${Object.keys(pastMap).length}`);
    for(const h of race.horses){
      h.prev=pastMap[h.horseId]||null;
      if(!pedCache[h.horseId]){
        try{
          const pt=await get(`https://db.netkeiba.com/horse/ped/${h.horseId}/`);
          const vals=parsePed(pt);
          pedCache[h.horseId]={name:horseName(pt), ped:vals, sire:vals?vals[2]:'', bms:vals?vals[6]:''};
          await sleep(400);
        }catch(e){ pedCache[h.horseId]={name:'',ped:null,sire:'',bms:''}; }
      }
      const c=pedCache[h.horseId];
      h.name=c.name; h.sire=c.sire; h.bms=c.bms; h.ped=c.ped;
    }
    races.push(race);
    await sleep(300);
  }
  const data={generatedAt:new Date().toISOString(), date, track:'函館', races};
  writeFileSync(out, 'window.KEIBA_PED='+JSON.stringify(data)+';\n', 'utf8');
  console.error('WROTE',out,'races',races.length);

  // 複勝回収率エビデンス（パンダズ函館2021-25）を自動生成
  try{
    const ev=await scrapePandas();
    const evOut=fileURLToPath(new URL('../evidence-data.js',import.meta.url));
    writeFileSync(evOut, 'window.KEIBA_EV='+JSON.stringify(ev)+';\n', 'utf8');
    console.error('WROTE',evOut,'evidence',ev.length);
  }catch(e){ console.error('pandas evidence skip:', e.message); }
}
main();
