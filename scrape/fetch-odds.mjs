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
      if(o && Object.keys(o.horses).length){ races[id]=o; live++; }
      await sleep(250);
    }catch(e){ /* skip */ }
  }
  const data={ fetchedAt:new Date().toISOString(), date, races };
  writeFileSync(out, 'window.KEIBA_ODDS='+JSON.stringify(data)+';\n', 'utf8');
  console.error(`WROTE ${out} races=${Object.keys(races).length}/${ids.length} (live odds=${live})`);
}
main();
