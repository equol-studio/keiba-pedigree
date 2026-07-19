// 函館の【確定結果＋払戻】を取得して result.js を生成（検証・バックテスト用）
// 使い方: node scrape/fetch-results.mjs YYYYMMDD [outPath]
// 依存なし（Node 18+ の標準 fetch を使用）
// ※レース確定後に実行すること（未確定だと着順が空で落ちる）
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/* 競馬場コード。TRACK env か --track= で切替（既定=函館）。 */
const TRACKS={'01':'札幌','02':'函館','03':'福島','04':'新潟','05':'東京','06':'中山','07':'中京','08':'京都','09':'阪神','10':'小倉'};
function trackCode(x){ if(!x) return '02'; if(TRACKS[x]) return x; const h=Object.entries(TRACKS).find(([,n])=>n===x); return h?h[0]:'02'; }
const _ta=(process.argv.find(a=>a.startsWith('--track='))||'').split('=')[1];
const TRACK=trackCode(_ta||process.env.TRACK||'函館');
const TRACK_NAME=TRACKS[TRACK];
const strip=s=>s.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();

async function get(url){
  const res=await fetch(url,{headers:{'User-Agent':UA,'Referer':'https://race.netkeiba.com/'}});
  const buf=Buffer.from(await res.arrayBuffer());
  let txt=new TextDecoder('euc-jp').decode(buf);
  if((txt.match(/�/g)||[]).length>20) txt=buf.toString('utf8');
  return txt;
}

async function raceIdsForDate(date){
  const t=await get(`https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${date}`);
  const ids=[...new Set([...t.matchAll(/race_id=(\d{12})/g)].map(m=>m[1]))];
  return ids.filter(id=>id.slice(4,6)===TRACK).sort();   // 02=函館
}

// 数字列の取り出し（"2 6 3" / "2 / 6" どちらも拾う）
const nums=s=>(s||'').trim().split(/[\s\/]+/).filter(Boolean).map(Number).filter(n=>!isNaN(n));
const yens=s=>(s||'').split('/').map(x=>+x.replace(/[^0-9]/g,'')).filter(n=>n);

function parseResult(t){
  const tbl=(t.match(/<table[^>]*summary="全着順"[\s\S]*?<\/table>/)||[])[0]||'';
  return [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r=>{
    const td=[...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x=>strip(x[1]));
    if(td.length<8) return null;
    const umaban=+td[2];
    if(!umaban) return null;
    return {
      chaku:td[0],                       // 着順（"1" / "中止" 等の文字列のまま）
      waku:+td[1], umaban, name:td[3],
      time:td[7], ninki:+td[9]||null, odds:parseFloat(td[10])||null
    };
  }).filter(Boolean);
}

function parsePay(t){
  const tbls=[...t.matchAll(/<table[^>]*class="Payout_Detail_Table"[\s\S]*?<\/table>/g)].map(x=>x[0]).join('');
  const rows=[...tbls.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r=>{
    const th=strip((r[1].match(/<th[^>]*>([\s\S]*?)<\/th>/)||[])[1]||'');
    const td=[...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x=>x[1].replace(/<br\s*\/?>/g,'|'));
    return {type:th, comb:strip(td[0]||''), yen:strip(td[1]||'').replace(/\s*\|\s*/g,' / ')};
  }).filter(x=>x.type);
  const pick=t2=>rows.find(x=>x.type===t2)||{comb:'',yen:''};

  // 複勝は 馬番→配当 のマップに（採点で一番使う形）
  const f=pick('複勝'), fu=nums(f.comb), fy=yens(f.yen), fuku={};
  fu.forEach((u,i)=>{ if(fy[i]) fuku[u]=fy[i]; });
  // ワイドは2頭ずつのペアに割る
  const w=pick('ワイド'), wn=nums(w.comb), wy=yens(w.yen), wide=[];
  for(let i=0;i+1<wn.length;i+=2) if(wy[i/2]) wide.push({c:[wn[i],wn[i+1]], y:wy[i/2]});
  const tan=pick('単勝'), uren=pick('馬連'), san=pick('3連複'), tan3=pick('3連単');

  return {
    tan:{c:nums(tan.comb)[0]||null, y:yens(tan.yen)[0]||0},
    fuku, wide,
    umaren:{c:nums(uren.comb), y:yens(uren.yen)[0]||0},
    sanpuku:{c:nums(san.comb), y:yens(san.yen)[0]||0},
    santan:{c:nums(tan3.comb), y:yens(tan3.yen)[0]||0}
  };
}

async function main(){
  const date=process.argv[2]||new Date().toISOString().slice(0,10).replace(/-/g,'');
  const out=process.argv[3]||fileURLToPath(new URL('../result-data.js',import.meta.url));
  const ids=await raceIdsForDate(date);
  if(!ids.length){ console.error(`no races for ${date}`); process.exit(1); }

  const races={};
  let done=0;
  for(const id of ids){
    try{
      const t=await get(`https://race.netkeiba.com/race/result.html?race_id=${id}`);
      const result=parseResult(t);
      if(!result.length){ console.error(`skip ${id}: no result rows (未確定?)`); await sleep(400); continue; }
      races[id]={
        no:+id.slice(-2),
        name:strip((t.match(/<div class="RaceName"[^>]*>([\s\S]*?)<\/div>/)||[])[1]||''),
        info:strip((t.match(/<div class="RaceData01"[^>]*>([\s\S]*?)<\/div>/)||[])[1]||''),
        result, pay:parsePay(t)
      };
      done++;
    }catch(e){ console.error(`skip ${id}: ${e.message}`); }
    await sleep(600);
  }

  // 全滅・大幅欠けなら書かない（未確定時に空ファイルで上書きする事故を防ぐ）
  if(done < ids.length/2){
    console.error(`ABORT: only ${done}/${ids.length} races had results — not writing`);
    process.exit(1);
  }
  const data={fetchedAt:new Date().toISOString(), date, track:TRACK_NAME, races};
  writeFileSync(out, 'window.KEIBA_RESULT='+JSON.stringify(data)+';\n', 'utf8');
  console.error(`WROTE ${out} races=${done}/${ids.length}`);
}
main();
