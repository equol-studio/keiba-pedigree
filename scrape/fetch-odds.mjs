// 函館 全レースの単勝・複勝・人気を高速取得 → odds-data.js
// 使い方: node scrape/fetch-odds.mjs YYYYMMDD [outPath]
// netkeibaオッズAPI(JSON)を使用。血統(pedigree-data.js)とは別に頻繁更新する想定。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getText(url){
  const res=await fetch(url,{headers:{'User-Agent':UA,'Referer':'https://race.netkeiba.com/'}});
  const buf=Buffer.from(await res.arrayBuffer());
  let t=new TextDecoder('euc-jp').decode(buf);
  if((t.match(/�/g)||[]).length>20) t=buf.toString('utf8');
  return t;
}
async function raceIdsForDate(date){
  const t=await getText(`https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${date}`);
  const ids=[...new Set([...t.matchAll(/race_id=(\d{12})/g)].map(m=>m[1]))];
  return ids.filter(id=>id.slice(4,6)==='02').sort();  // 02=函館
}
// ライブ馬場・天候（タグ分割に対応してタグ除去後にパース）
async function fetchGoing(raceId){
  for(let a=0;a<2;a++){   // レート制限でRaceData01が落ちることがあるのでリトライ
    try{
      const t=await getText(`https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`);
      const clean=t.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ');
      const g=((clean.match(/馬場[:：]\s*(不良|稍\s*重|良|重)/)||[])[1]||'').replace(/\s/g,'');
      const w=(clean.match(/(?:天候|天気)[:：]\s*(晴|曇|雨|小雨|雪)/)||[])[1]||'';
      if(g||w) return {going:g, weather:w};
    }catch(e){}
    await sleep(700);
  }
  return {going:'',weather:''};
}
async function fetchOdds(raceId){
  const u=`https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${raceId}&type=1&action=init`;
  const res=await fetch(u,{headers:{'User-Agent':UA,'Referer':`https://race.netkeiba.com/odds/index.html?race_id=${raceId}`}});
  let j; try{ j=JSON.parse(await res.text()); }catch(e){ return null; }
  if(!j.data || !j.data.odds || !j.data.odds['1']) return null;
  const win=j.data.odds['1'], place=j.data.odds['2']||{};
  const horses={};
  for(const k in win){
    const uma=+k;
    horses[uma]={ tan:win[k][0], pop:+win[k][2]||null, fukuLo:place[k]?place[k][0]:'', fukuHi:place[k]?place[k][1]:'' };
  }
  return { datetime:j.data.official_datetime||'', horses };
}

async function main(){
  const date=process.argv[2];
  const out=process.argv[3]||fileURLToPath(new URL('../odds-data.js',import.meta.url));
  if(!date){ console.error('usage: node fetch-odds.mjs YYYYMMDD [outPath]'); process.exit(1); }
  const ids=await raceIdsForDate(date);
  const races={};
  let live=0;
  for(const id of ids){
    try{
      const o=await fetchOdds(id);
      const g=await fetchGoing(id);
      if(o && Object.keys(o.horses).length){ races[id]=Object.assign(o,g); live++; }
      else if(g.going){ races[id]={horses:{},going:g.going,weather:g.weather}; }  // オッズ無くても馬場は残す
      await sleep(250);
    }catch(e){ /* skip */ }
  }
  // 現在の函館馬場（開催全体で共通・雨で悪化）＝取得できた中で最も重い値を、空のレースに補完
  const sev={'不良':4,'重':3,'稍重':2,'良':1};
  const goings=Object.values(races).map(r=>r.going).filter(Boolean);
  const cur=goings.sort((a,b)=>(sev[b]||0)-(sev[a]||0))[0]||'';
  for(const id in races){ if(!races[id].going && cur){ races[id].going=cur; races[id].goingEst=true; } }
  const data={ fetchedAt:new Date().toISOString(), date, currentGoing:cur, races };
  writeFileSync(out, 'window.KEIBA_ODDS='+JSON.stringify(data)+';\n', 'utf8');
  console.error(`WROTE ${out} races=${Object.keys(races).length}/${ids.length} (live odds=${live})`);
}
main();
