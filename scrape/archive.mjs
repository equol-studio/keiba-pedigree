// 開催日のデータ一式を data/YYYYMMDD/ に保存（＝あとから買い方・軸ロジックを再検証するための土台）
// 使い方: node scrape/archive.mjs [YYYYMMDD]   ※省略時は今の pedigree-data.js の日付
//
// なぜ必要か：pedigree-data.js / odds-data.js は毎開催 上書きされる。
// 保存しないと「あの日こう買っていたら」を後から計算できず、検証ログの数字だけが残って較正できない。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const p = (...a) => ROOT + a.join('/');

// window.X=... 形式のデータファイルを Node で読む
function loadWindowFile(file){
  const txt = readFileSync(file, 'utf8');
  const win = {};
  new Function('window', txt)(win);
  return win;
}

function dateOf(file, key){
  try { return loadWindowFile(file)[key]?.date || null; } catch { return null; }
}

const argDate = process.argv[2];
const pedDate = dateOf(p('pedigree-data.js'), 'KEIBA_PED');
const date = argDate || pedDate;

if(!/^\d{8}$/.test(date||'')){
  console.error('日付が特定できません。node scrape/archive.mjs YYYYMMDD で指定してください。');
  process.exit(1);
}

const dir = p('data', date);
mkdirSync(dir, {recursive:true});

// ---- 血統・オッズは「その日のものだけ」保存する（別開催のデータを誤って保存しないため） ----
const copies = [
  {src:'pedigree-data.js', dst:'pedigree-data.js', key:'KEIBA_PED'},
  {src:'odds-data.js',     dst:'odds-data.js',     key:'KEIBA_ODDS'}
];
const saved = [], skipped = [];
for(const c of copies){
  const src = p(c.src);
  if(!existsSync(src)){ skipped.push(`${c.src}(無し)`); continue; }
  const d = dateOf(src, c.key);
  if(d !== date){ skipped.push(`${c.src}(日付${d||'不明'}≠${date})`); continue; }
  writeFileSync(p('data', date, c.dst), readFileSync(src), null);
  saved.push(c.dst);
}

// ---- 結果は毎回スクレイプ（未取得なら）----
const resPath = p('data', date, 'result.js');
if(existsSync(resPath)){
  saved.push('result.js(既存)');
} else {
  const r = spawnSync(process.execPath, [p('scrape','fetch-results.mjs'), date, resPath], {stdio:'inherit'});
  if(r.status === 0) saved.push('result.js');
  else skipped.push('result.js(取得失敗＝未確定?)');
}

// ---- 目次を更新（アプリ／バックテストがどの開催を持っているか一覧できるように）----
const dates = readdirSync(p('data'), {withFileTypes:true})
  .filter(e => e.isDirectory() && /^\d{8}$/.test(e.name))
  .map(e => e.name).sort().reverse();
const index = dates.map(d => ({
  date: d,
  has: ['pedigree-data.js','odds-data.js','result.js'].filter(f => existsSync(p('data', d, f)))
}));
writeFileSync(p('data','index.json'), JSON.stringify({updated:new Date().toISOString(), meetings:index}, null, 1), 'utf8');

console.error(`ARCHIVED data/${date}/  保存:[${saved.join(', ')||'なし'}]  スキップ:[${skipped.join(', ')||'なし'}]`);
console.error(`目次 data/index.json → ${index.length}開催`);
if(!saved.length) process.exit(1);
