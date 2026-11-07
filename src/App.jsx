import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
// v7.2 / 2026-10-14: robust iPhone viewport and modal positions; compact 28px checkboxes with 44px tap targets; active habits first; extended partner dialogue.


// ─── v6 XP・日付・保存の共通ロジック ──────────────────────────
const pad2 = n => String(n).padStart(2,"0");
const localDateKey = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const fromDateKey = key => { const [y,m,d] = key.split("-").map(Number); return new Date(y,m-1,d,12); };
const addDateDays = (key,days) => { const d = fromDateKey(key); d.setDate(d.getDate()+days); return localDateKey(d); };
const getLogicalDate = (offset=0) => localDateKey(new Date(Date.now()-offset*3600000));
const getLogicalDow = (offset=0) => fromDateKey(getLogicalDate(offset)).getDay();
const today = () => getLogicalDate(0);
const todayDow = () => getLogicalDow(0);
const DOW_LABELS = ["日","月","火","水","木","金","土"];
// Lv30以降、3習慣×45XP/日で30日間の1350XPに必要経験値を固定
function xpForLevel(level) {
  if (level <= 15) return Math.floor(10*Math.pow(level,1.2));
  return Math.min(1350,257+73*(level-15));
}
function calcLevel(xp) {
  const balance=Math.max(0,Number(xp)||0); let level=1,spent=0;
  for (;level<1000000;level++) { const need=xpForLevel(level); if (balance<spent+need) return {level,currentXp:balance-spent,nextLevelXp:need};spent+=need; }
  return {level,currentXp:0,nextLevelXp:1350};
}
function calcBaseXp(id,logs) {
  const count=logs.filter(l=>l.habit_id===id&&!l.is_reverted&&!l.is_bonus).length;
  return count>=100?4:count>=30?3:count>=10?2:1;
}
function calcStreakBonus(days) { return days>=30?4:days>=14?3:days>=7?2:days>=2?1:0; }
function calcStreakDays(habit,logs,key) {
  if(habit.frequency!=="daily")return 0;
  const dates=new Set(logs.filter(l=>l.habit_id===habit.id&&!l.is_reverted&&!l.is_bonus).map(l=>l.executed_date));
  let days=0,cur=addDateDays(key,-1);
  while(dates.has(cur)&&days<100000){days++;cur=addDateDays(cur,-1);}return days;
}
const hasHabitDone=(logs,id,key)=>logs.some(l=>l.habit_id===id&&l.executed_date===key&&!l.is_bonus&&!l.is_reverted);
function isWeeklyNStreak(habit,logs,key) {
  const selected=[...new Set(habit.days_of_week||[])]; if(!selected.length)return false;
  const end=addDateDays(key,-(fromDateKey(key).getDay()+1));
  const start=addDateDays(end,-6), created=habit.created_at?localDateKey(new Date(habit.created_at)):"0000-01-01";
  for(let day=start;day<=end;day=addDateDays(day,1)){
    if(!selected.includes(fromDateKey(day).getDay()))continue;
    if(day<created||!hasHabitDone(logs,habit.id,day))return false;
  }
  return true;
}
function isStreak(habit,logs,key) {
  if(habit.frequency==="daily")return hasHabitDone(logs,habit.id,addDateDays(key,-1));
  if(habit.frequency==="weekly")return hasHabitDone(logs,habit.id,addDateDays(key,-7));
  return isWeeklyNStreak(habit,logs,key);
}
function isHabitScheduledOnDate(h,key) {
  if(h.deleted)return false;
  const dow=fromDateKey(key).getDay();
  return h.frequency==="daily"||(h.frequency==="weekly"&&h.day_of_week===dow)||
    (h.frequency==="weekly_n"&&(h.days_of_week||[]).includes(dow));
}
function isHabitEligibleOnDate(h,key){return isHabitScheduledOnDate(h,key)&&(h.is_active||h.graduated_on===key);}
const isHabitActiveToday=(h,dow)=>h.is_active&&!h.deleted&&(h.frequency==="daily"||(h.frequency==="weekly"&&h.day_of_week===dow)||(h.frequency==="weekly_n"&&(h.days_of_week||[]).includes(dow)));
const isWeeklyNToday=(h,dow)=>h.frequency==="weekly_n"&&(h.days_of_week||[]).includes(dow);
const calculateXp=logs=>logs.filter(l=>!l.is_reverted).reduce((sum,l)=>sum+(l.xp_gained||0),0);
const bonusKind=l=>l.bonus_type||"all"; // 旧is_bonusは全クリとして扱う
function reconcileBonuses(logs,habits,key,{allowAllNew=false}={}){
  let next=logs.map(l=>({...l}));
  const eligible=habits.filter(h=>isHabitEligibleOnDate(h,key));
  const done=eligible.filter(h=>hasHabitDone(next,h.id,key));
  const first=done.length?15:0;
  const all=eligible.length&&done.length===eligible.length?eligible.length*2:0;
  for(const [kind,xp] of [["first",first],["all",all]]){
    const found=next.find(l=>l.is_bonus&&l.executed_date===key&&bonusKind(l)===kind);
    if(found){
      const actual=(kind==="all"&&!allowAllNew&&found.is_reverted)?0:xp;
      next=next.map(l=>l.id===found.id?{...l,bonus_type:kind,xp_gained:actual||l.xp_gained,is_reverted:!actual}:l);
    } else if(xp&&(kind==="first"||allowAllNew)){
      next.push({id:`bonus-${kind}-${key}`,habit_id:null,executed_date:key,completed_at:new Date().toISOString(),xp_gained:xp,is_bonus:true,bonus_type:kind,is_reverted:false});
    }
  }
  return next;
}
const STORAGE_KEYS={habits:"pon_habits",logs:"pon_logs",status:"pon_status",settings:"pon_settings",trigger:"pon_trigger",trigger_logs:"pon_trigger_logs",graduations:"pon_graduations",recovery_events:"pon_recovery_events"};
function load(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
function save(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{/* 個人用。公開時に失敗表示追加 */}}

// ─── パートナーコメント（136種＋時間帯32種）────────────────
function buildComments(name) {
  return {
    idle: [
    "今日の分、ひとつずついこう",
    "始める前がいちばん気が重いんだよね",
    "最初のひとつが、今日を変えるよ",
    "大きなことはしなくていい。まずひとつ",
    "今できることから始めてみよう",
    "気負わずに、いつもの一歩から",
    "完璧じゃなくていい。動けたら十分",
    "始めるまでの数分が山場かもね",
    "今日の自分にできる分を探そう",
    "よし、最初のチェックをつけにいこう",
    "準備ができたら、ひとつだけ",
    "小さい行動も、立派な行動だよ",
    "考えるより先に、少し動いてみよう",
    "昨日と同じでも、今日の一歩には意味がある",
    "全部を考えず、まず目の前のひとつ",
    "始めてしまえば意外と進むかもしれない",
    "気が乗らない日ほど、入口を小さく",
    "今日も一日分、積み重ねていこう",
    "急がなくていい、止まらずにいこう",
    "迷ったら、いつもの習慣から",
    "やる気を待たなくても始められるよ",
    "どの習慣からやってみようか",
    "一歩目に必要なのは、少しの時間だけ",
    "記録は後からついてくる。まず行動",
    "今の自分にちょうどいいペースで"
    ],
    partial: [
    "ひとつ進んだね。次はどうする？",
    "もう動き出してる。いい流れだよ",
    "ここまでできた分を大切にしよう",
    "あと少し。自分のペースでね",
    "今日の積み上げが見えてきた",
    "最初の一歩を越えたね",
    "全部できなくても、できた分は残る",
    "一度始めた流れ、うまく使おう",
    "もう一つできたら、今日はさらに前進",
    "ここから先は無理なく選ぼう",
    "今日できたことを数えてみよう",
    "行動した事実はちゃんと残ってる",
    "残りは焦らず、ひとつずつ",
    "途中まででもゼロじゃないよ",
    "頑張りすぎないで、次の一件へ",
    "いいリズム。できるところまでいこう",
    "順番は自由。進めやすいものから",
    "最初のひとつをやった自分、忘れないで",
    "積み上げ途中の景色もいいね",
    "少しずつ形になってきたよ",
    "残りの習慣に手を伸ばしてみよう",
    "一件ずつでいい。続きはここから",
    "昨日より、今できることを見よう",
    "ここからもう一歩、いけそうかな",
    "無理はせず、続けられる歩幅で"
    ],
    allDone: [
    "全部完了。今日はやり切ったね",
    "全クリ！今日の積み重ね、受け取ったよ",
    "今日のリストにチェックが並んだね",
    "やると決めたことを、全部できた",
    "今日はここまで。しっかり休もう",
    "全部終わった。いい締めくくりだね",
    "おつかれさま。今日の分は完了",
    "今日の自分との約束、守れたね",
    "全クリ達成。着実に進んでるよ",
    "ひとつずつ進めた結果が、この画面だね",
    "今日の頑張り、ちゃんと残ってる",
    "よく続けたね。今日は胸を張ろう",
    "小さなチェックが、全部そろったよ",
    "ひとつずつの積み重ねが効いたね",
    "今日のミッション、クリア！",
    "終わったら休んでいい。そこも大事",
    "全クリの瞬間は、やっぱりうれしいね",
    "今日もやりきった。次は明日でいいよ",
    "習慣に使った時間、自分への投資だね",
    "きれいにチェックがそろったよ",
    "手をつけたところから、ここまで来たね",
    "今日の行動は、明日の自分に届く",
    "よくやった。今日はもう追加の宿題なし",
    "記録が少しずつ自信になっていくね",
    "またひとつ、続けた日が増えたよ",
    "全クリ！自分で決めた分を終えられたね"
    ],
    levelUp: [
    "レベルアップ！積み上げが数字になったね",
    "やったね、新しいレベルへ",
    "今日の一歩も成長につながったよ",
    "続けてきた記録が、レベルになったね",
    "一段上へ。ここからもいつもどおり",
    "成長してる。次は何を続けようか",
    "レベルが上がった！積み重ねの結果だよ",
    "一つ上の景色だね。おめでとう",
    "今日までの小さな行動に拍手",
    "おめでとう。ここからも無理なく",
    "成長の形が見えたね。いい感じ",
    "特別なことより、いつもの積み重ね",
    "次のレベルも、毎日の一歩から",
    "努力を数字で見られる日だね",
    "続けた時間は、ちゃんと力になってる"
    ],
    streak: [
    "続けるって簡単じゃない。それでも進んでるね",
    "連続記録が続いてるよ",
    "昨日の一歩が今日につながってる",
    "続いてきた流れ、大切にしよう",
    "ここまで積み上げた日々があるね",
    "日々の小さな行動が道になってる",
    "習慣が少しずつ身近になってきたね",
    "連続記録、少しずつ伸ばそう",
    "今日は昨日の続きになる日だね",
    "自分で作ったリズムを育てよう",
    "いつもの行動を今日もひとつ",
    "焦らず続けるのがいちばん強いね",
    "積み上げた日付が増えてきたね",
    "一歩ずつ、記録をつないでいこう",
    "今日も続けられたらうれしいね"
    ],
    empty: [
    "まずは一つ、続けたいことを決めよう",
    "最初から五つ作らなくていいよ",
    "小さな習慣を一つだけ登録してみよう",
    "始めやすいことが、続きやすいこと",
    "ここから好きなペースで始めよう",
    "まずは一つ。そこから育てていこう",
    "続けたいことを思い浮かべてみよう",
    "最初は簡単な約束からでいい",
    "自分の生活に合う習慣を選ぼう",
    "毎日じゃなくても、始める意味はある",
    "最初の一歩をここに置いてみよう",
    "続けられそうなこと、一緒に探そう",
    "今の自分に必要な習慣は何だろう",
    "ひとつ決めたら、それでスタート",
    "数より、続けたい気持ちを大事に"
    ],
    noTask: [
    "今日は予定なし。余白も大事だね",
    "今日の習慣はお休み。のんびりしよう",
    "予定がない日も、記録の一部だよ",
    "次の実施日まで、ゆっくり過ごしてね",
    "無理に習慣を増やさなくていいよ",
    "休む日を作るのも、続ける工夫",
    "今日は自由な時間を楽しもう",
    "今日はチェックをつけなくて大丈夫",
    "計画した休みなら、遠慮はいらない",
    "今日の分は空白でいい。次に備えよう",
    "次の習慣の日に、またここで",
    "習慣は毎日じゃなくても育っていく",
    "休みの日にまで頑張らなくていい",
    "今日は気楽に。次は予定日にね",
    "今日はオフ。何をして過ごそうか"
    ]
  };
}
const TIME_COMMENTS = {
  morning: [
    "朝の一歩は、小さくても頼もしい",
    "おはよう。今日は何から始めよう",
    "朝はまず、できることをひとつ",
    "新しい一日のリズムを作ろう",
    "朝に決めた一歩を大事にね",
    "午前中の自分に、少しだけ時間を",
    "起きてからの流れを味方にしよう",
    "今日の始まり、ゆっくりでいいよ"
  ],
  day: [
    "昼のすき間に、ひとつ進める？",
    "今日の残り時間をどう使おうか",
    "ちょっとした休憩のあとに一歩",
    "忙しい日も、自分のペースで",
    "午後の自分にできることをひとつ",
    "今やれるところから、軽く進もう",
    "今日の予定をちらっと見直そう",
    "時間ができたら、ここから再開"
  ],
  evening: [
    "一日の終わりに、小さな一歩",
    "おつかれさま。今日の分を確認しよう",
    "夜は無理なく、できる範囲で",
    "夕方のひと息を入れてからでもいい",
    "今日の自分のペースを尊重しよう",
    "ここから一件、進められるかな",
    "終わる前に、やっておきたいことは？",
    "帰ってきてからの習慣も大切だね"
  ],
  night: [
    "遅い時間だね。無理はしないで",
    "今日はあと少し。睡眠も大事だよ",
    "夜更かししてまで頑張らなくていい",
    "今夜できることだけ、ひとつ",
    "一日の締めくくりは落ち着いて",
    "今日は十分頑張ったなら、休んでね",
    "眠る前の短い時間を大切に",
    "明日の自分にも余裕を残そう"
  ]
};
function getPonComment(state, partnerName = "ぽん", previous = "") {
  const normal = buildComments(partnerName)[state] || buildComments(partnerName).idle;
  const hour = new Date().getHours();
  const part = hour >= 5 && hour < 11 ? "morning"
    : hour < 17 && hour >= 11 ? "day"
    : hour < 22 && hour >= 17 ? "evening" : "night";
  // 時間帯コメントはまだ着手前のときにのみ表示。全クリ時に励ましを混ぜない。
  const pool = state === "idle" ? [...normal, ...TIME_COMMENTS[part]] : normal;
  const alternatives = pool.filter(comment => comment !== previous);
  const candidates = alternatives.length ? alternatives : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ─── アイコン（SVG）───────────────────────────────────────────────
const Icon = ({ name, size = 20, color = "currentColor" }) => {
const icons = {
check: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />,
plus: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />,
edit: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />,
trash: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />,
home: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />,
list: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />,
history: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />,
x: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />,
bell: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />,
toggle_on: <><rect x="1" y="6" width="22" height="12" rx="6" fill="currentColor" opacity="0.3"/><circle cx="16" cy="12" r="5" fill="currentColor"/></>,
toggle_off: <><rect x="1" y="6" width="22" height="12" rx="6" fill="currentColor" opacity="0.15"/><circle cx="8" cy="12" r="5" fill="currentColor" opacity="0.4"/></>,
chevron_right: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />,
};
return (
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} xmlns="http://www.w3.org/2000/svg">
{icons[name]}
</svg>
);
};

// ─── テーマ定義 ──────────────────────────────────────────────────
const THEMES = {
dark: {
id: "dark",
name: "シック・ナイト",
bg: "#111318",
card: "#1a1d25",
cardAlt: "#1f2330",
border: "rgba(255,255,255,0.07)",
text: "#d4d8e2",
textMuted: "#6b7280",
textDim: "#4b5563",
accent: "#4ade80",
accentDim: "rgba(74,222,128,0.12)",
accentGlow: "rgba(74,222,128,0.25)",
danger: "#f87171",
dangerDim: "rgba(248,113,113,0.12)",
white: "#ffffff",
inputBg: "rgba(255,255,255,0.05)",
inputBorder: "rgba(255,255,255,0.07)",
selectBg: "#1a1d25",
checkboxBorder: "rgba(255,255,255,0.22)",
xpBarEnd: "#86efac",
toastBg: "rgba(20,26,20,0.92)",
titleColor: "#ffffff",
},
light: {
id: "light",
name: "クリア・オーシャン",
bg: "#f0f6ff",
card: "#ffffff",
cardAlt: "#e8f2ff",
border: "rgba(56,142,220,0.15)",
text: "#1a3a5c",
textMuted: "#4a7aaa",
textDim: "#7aaad0",
accent: "#2196f3",
accentDim: "rgba(33,150,243,0.1)",
accentGlow: "rgba(33,150,243,0.25)",
danger: "#ef5350",
dangerDim: "rgba(239,83,80,0.1)",
white: "#ffffff",
inputBg: "rgba(33,150,243,0.05)",
inputBorder: "rgba(56,142,220,0.2)",
selectBg: "#ffffff",
checkboxBorder: "rgba(33,120,243,0.35)",
xpBarEnd: "#90caf9",
toastBg: "rgba(220,235,255,0.96)",
titleColor: "#1a3a5c",
},
warm: {
id: "warm",
name: "ソフト・ブロッサム",
bg: "#fdf6f0",
card: "#fffaf7",
cardAlt: "#fdf0ea",
border: "rgba(210,140,120,0.15)",
text: "#5c3a2e",
textMuted: "#a07060",
textDim: "#c4a090",
accent: "#e57a8a",
accentDim: "rgba(229,122,138,0.1)",
accentGlow: "rgba(229,122,138,0.22)",
danger: "#d9534f",
dangerDim: "rgba(217,83,79,0.1)",
white: "#ffffff",
inputBg: "rgba(229,122,138,0.05)",
inputBorder: "rgba(210,140,120,0.2)",
selectBg: "#fffaf7",
checkboxBorder: "rgba(229,122,138,0.4)",
xpBarEnd: "#f48fb1",
toastBg: "rgba(253,246,240,0.97)",
titleColor: "#5c3a2e",
},
};

// デフォルトテーマ（コンポーネント外からも参照できるよう変数で持つ）
let C = THEMES.dark;
const getTheme = (id) => THEMES[id] || THEMES.dark;

// ─── グローバルスタイル注入 ───────────────────────────────────────
const GlobalStyles = ({ theme }) => {
const T = theme || C;
return <style>{`
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; width: 100%; max-width: 100%; background: ${T.bg}; overflow-x: hidden; }
#root { height: 100dvh; min-height: 100dvh; overflow: hidden; }
html, body { overscroll-behavior: none; }
body { overflow: hidden; }
body { font-family: 'DM Sans', sans-serif; color: ${T.text}; -webkit-font-smoothing: antialiased; }
input, select, button, textarea { font-family: inherit; }
button { cursor: pointer; border: none; background: none; }


@keyframes fadeUp {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes shimmer {
  0% { opacity: 0.5; }
  50% { opacity: 1; }
  100% { opacity: 0.5; }
}
@keyframes xpFill {
  from { width: var(--xp-from); }
  to { width: var(--xp-to); }
}
@keyframes checkPop {
  0% { transform: scale(1); }
  50% { transform: scale(1.3); }
  100% { transform: scale(1); }
}
@keyframes levelUp {
  0% { transform: scale(1); opacity: 1; }
  30% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes ponFade {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes slideUp {
  from { transform: translateY(100%); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
@keyframes overlayIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes lvlParticle {
  0%   { opacity: 0.9; transform: translate(0, 0) scale(1); }
  100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(0.3); }
}
@keyframes lvlPanelIn {
  0%   { opacity: 0; transform: translateX(-50%) translateY(12px) scale(0.96); }
  60%  { opacity: 1; transform: translateX(-50%) translateY(-3px) scale(1.01); }
  100% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
}
@keyframes lvlPanelOut {
  0%   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
  100% { opacity: 0; transform: translateX(-50%) translateY(-8px) scale(0.97); }
}
@keyframes lvlBarFill {
  from { width: 0%; }
  to   { width: 100%; }
}
@keyframes lvlShimmer {
  0%   { background-position: -200% center; }
  100% { background-position: 200% center; }
}
@keyframes bonusReveal {
  0%   { opacity: 0; transform: translateY(5px) scale(0.96); }
  60%  { opacity: 1; transform: translateY(-1px) scale(1.02); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes bonusGlow {
  0%   { box-shadow: 0 0 0px rgba(74,222,128,0); }
  40%  { box-shadow: 0 0 14px rgba(74,222,128,0.2); }
  100% { box-shadow: 0 0 4px rgba(74,222,128,0.06); }
}
.check-pop { animation: checkPop 0.3s ease; }
.level-up { animation: levelUp 0.5s ease; }
.pon-fade { animation: ponFade 0.4s ease; }
.fade-up { animation: fadeUp 0.35s ease; }
.scale-in { animation: scaleIn 0.25s ease; }
.bonus-reveal { animation: bonusReveal 0.45s cubic-bezier(0.34,1.56,0.64,1) both, bonusGlow 1.4s ease both; }

::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 4px; }

input[type="time"]::-webkit-calendar-picker-indicator { filter: invert(0.5); cursor: pointer; }
input[type="time"] { appearance: none; -webkit-appearance: none; min-width: 0; }
input, select {
  background: ${T.inputBg || "rgba(255,255,255,0.05)"};
  border: 1px solid ${T.inputBorder || T.border};
  color: ${T.text};
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 16px; /* iOS Safari: avoid automatic input zoom */
  width: 100%;
  outline: none;
  transition: border-color 0.2s;
}
input:focus, select:focus { border-color: ${T.accent}66; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid ${T.accent}; outline-offset: 2px; }
.pon-scroll { -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
.pon-bottom-sheet input, .pon-bottom-sheet select { scroll-margin-bottom: 20px; }
.pon-root { overflow-x: clip; overscroll-behavior-x: none; }
.pon-modal-backdrop { overscroll-behavior: contain; }
select option { background: ${T.selectBg || T.card}; }

`}</style>;
};

// ─── 久しぶりの歓迎（正式な復帰判定ではない） ───────────
function ReturningUserOverlay({ daysSince, partnerName, onKeep }) {
  return (
    <div style={{position:"fixed",inset:0,zIndex:210,background:"rgba(0,0,0,.65)",display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
      <div style={{width:"100%",maxWidth:400,background:C.card,borderRadius:20,border:`1px solid ${C.border}`,padding:24,textAlign:"center"}}>
        <div style={{color:C.accent,fontSize:28,marginBottom:10}}>◈</div>
        <div style={{fontSize:18,color:C.text,marginBottom:10}}>おかえり！</div>
        <div style={{fontSize:13,color:C.textMuted,lineHeight:1.9,marginBottom:20}}>
          {daysSince}日ぶりだね。<br/>今日の習慣からまた始めよう。<br/>今までのXPと実績はそのままだよ。
        </div>
        <button onClick={onKeep} style={{width:"100%",padding:14,borderRadius:12,color:C.accent,background:C.accentDim,border:`1px solid ${C.accent}55`}}>今日の習慣へ</button>
      </div>
    </div>
  );
}

// ─── 週次ふりかえりオーバーレイ ─────────────────────────────────
function WeeklyReviewOverlay({ logs, habits, triggerLogs, triggerHabit, totalXp, level, partnerName, onClose, offset = 0 }) {
// 論理日付の先週日曜〜土曜
const logicalToday=getLogicalDate(offset);
const weekEnd=addDateDays(logicalToday,-(fromDateKey(logicalToday).getDay()+1));
const weekStart=addDateDays(weekEnd,-6);

// 先週の通常完了ログ
const weekLogs = logs.filter(l =>
!l.is_reverted && !l.is_bonus &&
l.executed_date >= weekStart && l.executed_date <= weekEnd
);
const weekXp = weekLogs.reduce((s, l) => s + (l.xp_gained || 0), 0)
+ logs.filter(l => l.is_bonus && !l.is_reverted && l.executed_date >= weekStart && l.executed_date <= weekEnd)
.reduce((s, l) => s + (l.xp_gained || 0), 0);

// 習慣別達成率
const activeHabits = habits.filter(h => !h.deleted && !h.is_trigger && (h.is_active || h.graduated_on));
const habitStats = activeHabits.map(h => {
const created=h.created_at?localDateKey(new Date(h.created_at)):"0000-01-01";
const hLogs=weekLogs.filter(l=>l.habit_id===h.id&&l.executed_date>=created&&(!h.graduated_on||l.executed_date<=h.graduated_on));
// 対象曜日数を計算
let expected = 0;
for(let day=weekStart;day<=weekEnd;day=addDateDays(day,1)) {
if(day<created||(h.graduated_on&&day>h.graduated_on))continue;
const dow=fromDateKey(day).getDay();
if (h.frequency === "daily") expected++;
else if (h.frequency === "weekly" && h.day_of_week === dow) expected++;
else if (h.frequency === "weekly_n" && (h.days_of_week || []).includes(dow)) expected++;
}
return { name: h.name, done: hLogs.length, expected: Math.max(expected, 0) };
});

// トリガー習慣の先週達成数
const triggerCount = triggerHabit
? (triggerLogs || []).filter(l => !l.is_reverted && l.executed_date >= weekStart && l.executed_date <= weekEnd).length
: 0;

// 全体達成率
const totalExpected = habitStats.reduce((s, h) => s + h.expected, 0);
const totalDone     = habitStats.reduce((s, h) => s + h.done, 0);
const rate = totalExpected > 0 ? Math.min(100,Math.round((totalDone / totalExpected) * 100)) : 0;

// ぽんのコメント（達成率ベース）
const reviewComment =
rate >= 100 ? `完璧な1週間。${partnerName}も誇りに思ってるよ` :
rate >= 80  ? "80%以上達成。十分すごいよ" :
rate >= 50  ? "半分以上こなした。それだけで十分進んでる" :
rate > 0    ? "少しでも動いた。それが積み重なっていくよ" :
"今週は休みの週。また来週いこう";

const fmt = (s) => {
const d = new Date(s + "T12:00:00");
return `${d.getMonth()+1}/${d.getDate()}`;
};

return (
<div style={{
position: "fixed", inset: 0, zIndex: 200,
background: "rgba(0,0,0,0.65)",
display: "flex", alignItems: "flex-end",
animation: "overlayIn 0.25s ease",
}}>
<div style={{
width: "100%", maxWidth: 480, margin: "0 auto",
background: C.card,
borderRadius: "20px 20px 0 0",
border: `1px solid ${C.border}`,
borderBottom: "none",
padding: "24px 20px 40px",
animation: "slideUp 0.35s ease",
maxHeight: "85vh",
overflowY: "auto",
}}>
{/* ヘッダー */}
<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
<div>
<div style={{ fontSize: 11, color: C.accent, letterSpacing: "0.1em", marginBottom: 4, fontFamily: "'DM Mono', monospace" }}>
WEEKLY REVIEW
</div>
<div style={{ fontSize: 16, fontWeight: 500, color: C.titleColor || C.text }}>
{fmt(weekStart)} 〜 {fmt(weekEnd)}
</div>
</div>
<button onClick={onClose} style={{ color: C.textMuted, padding: 4 }}>
<Icon name="x" size={20} />
</button>
</div>


    {/* 達成率サークル風 */}
    <div style={{
      display: "flex", alignItems: "center", gap: 20,
      padding: "16px 0", marginBottom: 16,
      borderBottom: `1px solid ${C.border}`,
    }}>
      <div style={{
        width: 72, height: 72, borderRadius: "50%",
        border: `3px solid ${rate >= 80 ? C.accent : C.border}`,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        flexShrink: 0,
        background: rate >= 80 ? C.accentDim : "transparent",
        boxShadow: rate >= 80 ? `0 0 16px ${C.accentGlow}` : "none",
        transition: "all 0.4s ease",
      }}>
        <span style={{ fontSize: 20, fontWeight: 600, color: C.accent, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>
          {rate}
        </span>
        <span style={{ fontSize: 9, color: C.textDim, letterSpacing: "0.05em" }}>%</span>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: C.text, lineHeight: 1.7 }}>{reviewComment}</div>
        <div style={{ fontSize: 11, color: C.textDim, marginTop: 4, fontFamily: "'DM Mono', monospace" }}>
          +{weekXp} XP / {totalDone}/{totalExpected} 回
        </div>
      </div>
    </div>

    {/* 習慣別 */}
    {habitStats.length > 0 && (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 10, letterSpacing: "0.06em" }}>習慣ごとの達成</div>
        {habitStats.map((h, i) => {
          const pct = h.expected > 0 ? Math.round((h.done / h.expected) * 100) : 0;
          return (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 13, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "70%" }}>{h.name}</span>
                <span style={{ fontSize: 11, color: C.textDim, fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{h.done}/{h.expected}</span>
              </div>
              <div style={{ height: 3, background: C.border, borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: pct >= 100 ? C.accent : C.textMuted, borderRadius: 2, transition: "width 0.6s ease" }} />
              </div>
            </div>
          );
        })}
      </div>
    )}

    {/* トリガー習慣 */}
    {triggerHabit && (
      <div style={{
        padding: "10px 14px", borderRadius: 10,
        border: `1px solid ${C.accent}33`, background: C.accentDim,
        marginBottom: 16, fontSize: 13,
      }}>
        <span style={{ color: C.accent, marginRight: 6, fontSize: 11 }}>◈</span>
        <span style={{ color: C.textMuted }}>{triggerHabit.name}</span>
        <span style={{ color: C.accent, fontFamily: "'DM Mono', monospace", marginLeft: 8, fontSize: 12 }}>
          {triggerCount}日
        </span>
      </div>
    )}

    {/* 来週へ */}
    <button
      onClick={onClose}
      style={{
        width: "100%", padding: "13px",
        borderRadius: 12,
        border: `1px solid ${C.accent}55`,
        background: C.accentDim,
        color: C.accent, fontSize: 14, fontWeight: 500,
      }}
    >来週もいこう</button>
  </div>
</div>

);
}

// ─── レベルアップオーバーレイ ────────────────────────────────────
function LevelUpOverlay({ level, onDone, partnerName = "ぽん" }) {
const { nextLevelXp } = calcLevel(10 * Math.pow(level, 1.2)); // 新レベルの必要XP参考値
const particles = Array.from({ length: 8 }, (_, i) => {
const angle = (i / 8) * Math.PI * 2;
const dist = 38 + Math.random() * 18;
return {
dx: `${Math.cos(angle) * dist}px`,
dy: `${Math.sin(angle) * dist}px`,
delay: `${i * 0.04}s`,
};
});

useEffect(() => {
const t = setTimeout(onDone, 3800);
return () => clearTimeout(t);
}, []);

return (
<div style={{
position: "absolute",
bottom: 72,
left: "50%",
transform: "translateX(-50%)",
zIndex: 60,
display: "flex",
flexDirection: "column",
alignItems: "center",
pointerEvents: "none",
}}>
{/* パーティクル */}
<div style={{ position: "relative", width: 0, height: 0 }}>
{particles.map((p, i) => (
<div
key={i}
style={{
position: "absolute",
width: 4,
height: 4,
borderRadius: "50%",
background: C.accent,
top: 0,
left: 0,
"–dx": p.dx,
"–dy": p.dy,
animation: `lvlParticle 0.9s cubic-bezier(0.25,1,0.5,1) ${p.delay} both`,
opacity: 0,
}}
/>
))}
</div>


  {/* メインパネル */}
  <div style={{
    animation: "lvlPanelIn 0.5s cubic-bezier(0.34,1.56,0.64,1) both, lvlPanelOut 0.4s ease 3.3s both",
    background: C.toastBg || C.card,
    border: `1px solid ${C.accent}66`,
    borderRadius: 16,
    padding: "16px 28px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    backdropFilter: "blur(12px)",
    boxShadow: `0 0 32px ${C.accentGlow}, 0 8px 32px rgba(0,0,0,0.4)`,
    minWidth: 200,
  }}>
    {/* シマーバー */}
    <div style={{
      height: 2,
      width: "100%",
      borderRadius: 2,
      background: `linear-gradient(90deg, transparent, ${C.accent}, transparent)`,
      backgroundSize: "200% 100%",
      animation: "lvlShimmer 1.8s linear 0.3s 2 both",
      marginBottom: 4,
      opacity: 0.7,
    }} />

    <div style={{
      fontSize: 10,
      color: C.accent,
      letterSpacing: "0.18em",
      opacity: 0.65,
      textTransform: "uppercase",
      fontFamily: "'DM Mono', monospace",
    }}>Level Up</div>

    <div style={{
      fontFamily: "'DM Mono', monospace",
      fontSize: 32,
      fontWeight: 500,
      color: C.titleColor || C.text,
      letterSpacing: "0.02em",
      lineHeight: 1,
    }}>
      {level}
    </div>

    {/* XPバー（0→満タン演出） */}
    <div style={{
      width: "100%",
      height: 3,
      background: C.border,
      borderRadius: 3,
      overflow: "hidden",
      marginTop: 4,
    }}>
      <div style={{
        height: "100%",
        background: `linear-gradient(90deg, ${C.accent}, ${C.xpBarEnd || C.accent})`,
        borderRadius: 3,
        animation: "lvlBarFill 0.8s cubic-bezier(0.4,0,0.2,1) 0.4s both",
        boxShadow: `0 0 6px ${C.accentGlow}`,
      }} />
    </div>

    <div style={{
      fontSize: 10,
      color: C.textDim,
      fontFamily: "'DM Mono', monospace",
      marginTop: 2,
      letterSpacing: "0.04em",
    }}>{partnerName}も喜んでるよ</div>
  </div>
</div>

);
}

// ─── XPバー ───────────────────────────────────────────────────────
function XPBar({ totalXp, prevXp }) {
const { level, currentXp, nextLevelXp } = calcLevel(totalXp);
const pct = Math.min((currentXp / nextLevelXp) * 100, 100);
const xpBarRef = useRef(null);

useEffect(() => {
if (!xpBarRef.current) return;
const { level: prevLevel, currentXp: prevCurrent, nextLevelXp: prevNext } = calcLevel(prevXp);
const fromPct = prevLevel === level
? Math.min((prevCurrent / prevNext) * 100, 100)
: 0;
xpBarRef.current.style.setProperty("--xp-from", `${fromPct}%`);
xpBarRef.current.style.setProperty("--xp-to", `${pct}%`);
xpBarRef.current.style.width = `${fromPct}%`;
const timeout = setTimeout(() => {
if (xpBarRef.current) {
xpBarRef.current.style.animation = "xpFill 0.8s ease forwards";
}
}, 100);
return () => clearTimeout(timeout);
}, [totalXp]);

return (
<div style={{ padding: "16px 20px", background: C.card, borderTop: `1px solid ${C.border}` }}>
<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
<span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: C.accent, letterSpacing: "0.08em" }}>
Lv.{level}
</span>
<span style={{ fontSize: 11, color: C.textDim, fontFamily: "'DM Mono', monospace" }}>
{currentXp} / {nextLevelXp} XP
</span>
</div>
<div style={{ height: 4, background: C.border, borderRadius: 4, overflow: "hidden" }}>
<div
ref={xpBarRef}
style={{
height: "100%",
width: `${pct}%`,
background: `linear-gradient(90deg, ${C.accent}, ${C.xpBarEnd || C.accent})`,
borderRadius: 4,
boxShadow: `0 0 8px ${C.accentGlow}`,
transition: "none",
}}
/>
</div>
</div>
);
}

// ─── ぽんエリア ───────────────────────────────────────────────────
function PonArea({ comment, state, partnerName = "ぽん" }) {
const [key, setKey] = useState(0);
const prevComment = useRef(comment);

useEffect(() => {
if (comment !== prevComment.current) {
prevComment.current = comment;
setKey(k => k + 1);
}
}, [comment]);

const glowColor = state === "allDone" ? C.accentGlow : C.cardAlt;
return (
<div style={{
padding: "20px 20px 16px",
display: "flex",
alignItems: "flex-start",
gap: 12,
}}>
<div style={{
width: 36,
height: 36,
borderRadius: 12,
background: state === "allDone" ? C.accentDim : C.cardAlt,
border: `1px solid ${state === "allDone" ? C.accent + "55" : C.border}`,
display: "flex",
alignItems: "center",
justifyContent: "center",
fontSize: 18,
flexShrink: 0,
boxShadow: `0 0 16px ${glowColor}`,
transition: "all 0.4s ease",
}}>
{state === "allDone" ? "✦" : state === "empty" ? "○" : "●"}
</div>
<div key={key} className="pon-fade" style={{ flex: 1, paddingTop: 2 }}>
<div style={{ fontSize: 11, color: C.textDim, marginBottom: 3, letterSpacing: "0.06em" }}>{partnerName}</div>
<div style={{ fontSize: 14, color: C.text, lineHeight: 1.6, fontWeight: 300 }}>{comment}</div>
</div>
</div>
);
}

// ─── タスク行 ─────────────────────────────────────────────────────
function TaskRow({ habit, log, onToggle, locked = false }) {
const done = log && !log.is_reverted;
const [anim, setAnim] = useState(false);

const handleToggle = () => {
setAnim(true);
setTimeout(() => setAnim(false), 300);
if(!locked)onToggle(habit.id);
};

const timeLabel = habit.notify_time || "—";
const freqLabel = habit.frequency === "weekly"
? `毎週${DOW_LABELS[habit.day_of_week]}`
: habit.frequency === "weekly_n"
? `週${(habit.days_of_week || []).length}回（${(habit.days_of_week || []).map(d => DOW_LABELS[d]).join("・")}）`
: "毎日";

return (
<div style={{
display: "flex",
alignItems: "center",
gap: 14,
padding: "10px 20px",
borderBottom: `1px solid ${C.border}`,
background: done ? C.accentDim.replace("0.1)", "0.05)").replace("0.12)", "0.04)") : "transparent",
transition: "background 0.3s ease",
}}>
<button
onClick={handleToggle}
disabled={locked}
aria-label={locked?"卒業済み":done?"完了を取り消す":"完了にする"}
className={anim ? "check-pop" : ""}
style={{
width: 44,
height: 44,
borderRadius: 10,
border: "none",
background: "transparent",
display: "flex",
alignItems: "center",
justifyContent: "center",
flexShrink: 0,
}}
>
<span aria-hidden="true" style={{
width: 28, height: 28, borderRadius: 7,
border: `2px solid ${done ? C.accent : C.checkboxBorder}`,
background: done ? C.accentDim : "transparent",
display: "flex", alignItems: "center", justifyContent: "center",
transition: "all 0.2s ease", pointerEvents: "none",
boxShadow: done ? `0 0 10px ${C.accentGlow}` : "none",
}}>
{done && <Icon name="check" size={15} color={C.accent} />}
</span>
</button>
<div style={{ flex: 1, minWidth: 0 }}>
<div style={{
fontSize: 15,
fontWeight: 400,
color: done ? C.textMuted : C.text,
textDecoration: done ? "line-through" : "none",
textDecorationColor: C.border,
whiteSpace: "nowrap",
overflow: "hidden",
textOverflow: "ellipsis",
transition: "color 0.2s",
}}>{habit.name}</div>
<div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{freqLabel}</div>
</div>
<div style={{
fontFamily: "'DM Mono', monospace",
fontSize: 12,
color: done ? C.accent : C.textMuted,
transition: "color 0.2s",
flexShrink: 0,
}}>{timeLabel}</div>
</div>
);
}

// ─── ホーム画面 ───────────────────────────────────────────────────
function HomeScreen({ habits, logs, userStatus, onToggle, prevXp, onGoToHabits, offset = 0, levelUpInfo, onLevelUpDone, partnerName = "ぽん", triggerHabit, triggerLogs, onTriggerToggle }) {
const todayStr = getLogicalDate(offset);
const dow = getLogicalDow(offset);
const todayHabits = habits.filter(h => isHabitEligibleOnDate(h,todayStr));
const todayLogs = logs.filter(l => l.executed_date === todayStr);
// 通常完了ログのみ（ボーナスログを除外して正確にカウント）
const doneCount = todayHabits.filter(h=>hasHabitDone(todayLogs,h.id,todayStr)).length;
const total = todayHabits.length;
// 全クリボーナスの状態
const bonusActive = todayLogs.some(l => l.is_bonus && bonusKind(l)==="all" && !l.is_reverted);
const bonusXpAmount = todayLogs
.filter(l => l.is_bonus && bonusKind(l)==="all" && !l.is_reverted)
.reduce((sum, l) => sum + (l.xp_gained || 0), 0);

const state = habits.length === 0 ? "empty"
: total === 0 ? "noTask"
: doneCount === 0 ? "idle"
: doneCount === total ? "allDone"
: "partial";

const [ponComment, setPonComment] = useState(() => getPonComment(state, partnerName));
const [bonusToast, setBonusToast] = useState(false);
const [bonusToastKey, setBonusToastKey] = useState(0);
const prevBonusActive = useRef(bonusActive);
// レベルアップ演出はApp側から props で受け取る（画面遷移で再発火しない）
const prevLevelUpInfo = useRef(null);

useEffect(() => {
// levelUpInfoが新しく来たときだけぽんコメントを変更
if (levelUpInfo && levelUpInfo !== prevLevelUpInfo.current) {
setPonComment(old => {
  const next = getPonComment("levelUp", partnerName, old);
  return next;
});
prevLevelUpInfo.current = levelUpInfo;
}
}, [levelUpInfo]);

useEffect(() => {
if (!levelUpInfo) {
setPonComment(old => {
  const next = getPonComment(state, partnerName, old);
  return next;
});
}
}, [state, partnerName, doneCount, todayStr]);

// ボーナス達成を検知してトーストを出す
useEffect(() => {
if (bonusActive && !prevBonusActive.current) {
setBonusToast(true);
setBonusToastKey(k => k + 1);
const t = setTimeout(() => setBonusToast(false), 3000);
prevBonusActive.current = true;
return () => clearTimeout(t);
}
if (!bonusActive) {
prevBonusActive.current = false;
setBonusToast(false);
}
}, [bonusActive]);

const getLogForHabit = (habitId) =>
todayLogs.find(l => l.habit_id === habitId && !l.is_reverted) ||
todayLogs.find(l => l.habit_id === habitId);

return (
<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden" }}>
{/* ぽんエリア */}
<PonArea comment={ponComment} state={state} partnerName={partnerName} />


  {/* 状態バー */}
  {total > 0 && (
    <div style={{ padding: "0 20px 14px" }}>
      <div style={{ height: 2, background: C.border, borderRadius: 2, overflow: "hidden" }}>
        <div style={{
          height: "100%",
          width: total > 0 ? `${(doneCount / total) * 100}%` : "0%",
          background: C.accent,
          borderRadius: 2,
          transition: "width 0.5s ease",
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
        <span style={{ fontSize: 11, color: C.textDim, fontFamily: "'DM Mono', monospace" }}>
          {doneCount}/{total} タスク
        </span>
        {bonusActive && (
          <span style={{
            fontSize: 11,
            fontFamily: "'DM Mono', monospace",
            color: C.accent,
            opacity: 0.85,
            display: "flex",
            alignItems: "center",
            gap: 3,
          }}>
            <span style={{ fontSize: 9, opacity: 0.6 }}>✦</span>
            +{bonusXpAmount} XP ボーナス
          </span>
        )}
      </div>
    </div>
  )}

  {/* タスク一覧 */}
  <div className="pon-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
    {/* トリガー習慣（毎日表示・独立） */}
    {triggerHabit && (() => {
      const todayStr = getLogicalDate(offset);
      const tLog = triggerLogs.find(l => l.executed_date === todayStr && !l.is_reverted);
      return <TriggerRow triggerHabit={triggerHabit} todayLog={tLog} onToggle={onTriggerToggle} />;
    })()}
    {state === "empty" && (
      <div className="fade-up" style={{ padding: "48px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 16, opacity: 0.3 }}>○</div>
        <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.8 }}>
          習慣がまだないね。<br />まずは1つ追加してみよう。
        </div>
        <button
          onClick={onGoToHabits}
          style={{
            marginTop: 24,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "9px 18px",
            borderRadius: 12,
            border: `1px solid ${C.border}`,
            background: "transparent",
            color: C.textMuted,
            fontSize: 13,
            letterSpacing: "0.02em",
            transition: "border-color 0.2s, color 0.2s",
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent + "55"; e.currentTarget.style.color = C.accent; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textMuted; }}
        >
          <span style={{ fontSize: 15, lineHeight: 1 }}>＋</span>
          習慣を追加する
        </button>
      </div>
    )}
    {state === "noTask" && (
      <div className="fade-up" style={{ padding: "48px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.8 }}>
          今日の予定はなし。<br />ゆっくりしよう。
        </div>
      </div>
    )}
    {todayHabits.map(h => (
      <TaskRow
        key={h.id}
        habit={h}
        log={getLogForHabit(h.id)}
        onToggle={onToggle}
        locked={h.graduated_on===todayStr}
      />
    ))}
  </div>

  {/* XPエリア */}
  <div className={levelUpInfo ? "level-up" : ""}>
    <XPBar totalXp={userStatus.total_xp} prevXp={prevXp} />
  </div>

  {/* ボーナストースト */}
  {bonusToast && (
    <div
      key={bonusToastKey}
      className="bonus-reveal"
      style={{
        position: "absolute",
        bottom: 80,
        left: "50%",
        transform: "translateX(-50%)",
        whiteSpace: "nowrap",
        background: C.toastBg || C.card,
        border: `1px solid ${C.accent}55`,
        borderRadius: 12,
        padding: "10px 18px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        backdropFilter: "blur(8px)",
        zIndex: 50,
      }}
    >
      <span style={{ fontSize: 13, color: C.accent }}>✦</span>
      <span style={{ fontSize: 13, color: C.text, fontWeight: 500, letterSpacing: "0.01em" }}>
        全クリボーナス
      </span>
      <span style={{
        fontFamily: "'DM Mono', monospace",
        fontSize: 12,
        color: C.accent,
        fontWeight: 600,
        marginLeft: 2,
      }}>
        +{bonusXpAmount} XP
      </span>
    </div>
  )}

  {/* レベルアップオーバーレイ */}
  {levelUpInfo && (
    <LevelUpOverlay
      level={levelUpInfo.level}
      onDone={onLevelUpDone}
      partnerName={partnerName}
    />
  )}
</div>

);
}

// ─── モーダルボタン共通スタイルヘルパー ─────────────────────────
const modalBtnStyle = (variant = "cancel") => ({
flex: 1,
padding: "12px",
borderRadius: 12,
border: variant === "danger"
? `1px solid ${C.danger}55`
: `1px solid ${C.border}`,
background: variant === "danger" ? C.dangerDim : variant === "save" ? C.accentDim : "transparent",
color: variant === "danger" ? C.danger : variant === "save" ? C.accent : C.textMuted,
fontSize: 14,
cursor: "pointer",
});

// ─── モーダル ─────────────────────────────────────────────────────
// iOSではキーボード表示中のvisualViewportが実際に見えている領域となる。
function getModalViewport() {
  if (typeof window === "undefined") return { top: 0, height: 700 };
  const v = window.visualViewport;
  return {
    top: Math.max(0, v ? v.offsetTop : 0),
    left: Math.max(0, v ? v.offsetLeft : 0),
    width: Math.max(240, Math.round(v ? v.width : window.innerWidth)),
    height: Math.max(120, Math.round(v ? v.height : window.innerHeight)),
    scale: v?.scale || 1
  };
}
function Modal({ onClose, children, title }) {
  const [viewport, setViewport] = useState(getModalViewport);
  const scrollRef = useRef(null);

  useEffect(() => {
    const update = () => setViewport(getModalViewport());
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    update();

    // Prevent the document behind the dialog from scrolling.
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.body.style.overflow = oldOverflow;
    };
  }, []);

  const handleFocus = event => {
    if (!event.target.closest("input, select, textarea")) return;
    const target = event.target;
    // scrollIntoView scrolls *every ancestor*, including Safari's page.
    // Scroll only inside the sheet so the whole app cannot slide horizontally.
    window.setTimeout(() => {
      const sheet = scrollRef.current;
      if (!sheet?.contains(target)) return;
      const targetRect = target.getBoundingClientRect();
      const sheetRect = sheet.getBoundingClientRect();
      if (targetRect.bottom > sheetRect.bottom - 20) {
        sheet.scrollTop += targetRect.bottom - sheetRect.bottom + 20;
      } else if (targetRect.top < sheetRect.top + 72) {
        sheet.scrollTop -= sheetRect.top + 72 - targetRect.top;
      }
    }, 350);
  };

  // A portal is essential here: an overlay inside the app's overflow:hidden
  // stacking context gets clipped and falls behind the persistent bottom nav.
  return createPortal(
    <div className="pon-modal-backdrop" onClick={onClose} style={{
      position: "fixed",
      left: viewport.left, top: viewport.top, height: viewport.height,
      width: viewport.width, maxWidth: "100%", zIndex: 10000,
      background: "rgba(0,0,0,0.65)",
      display: "flex", justifyContent: "center", alignItems: "flex-end",
      overflow: "hidden", animation: "overlayIn 0.2s ease",
      pointerEvents: "auto"
    }}>
      <div ref={scrollRef} className="pon-bottom-sheet pon-scroll"
        role="dialog" aria-modal="true" aria-label={title}
        onClick={event => event.stopPropagation()} onFocusCapture={handleFocus}
        style={{
          width: "100%", maxWidth: 480, minHeight: 0,
          maxHeight: "calc(100% - 8px)", margin: "0 auto",
          overflowY: "auto", overscrollBehavior: "contain",
          WebkitOverflowScrolling: "touch",
          background: C.card,
          borderRadius: "20px 20px 0 0",
          border: `1px solid ${C.border}`, borderBottom: "none",
          padding: "0 20px calc(28px + env(safe-area-inset-bottom, 0px))",
          animation: "slideUp 0.25s ease"
        }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          position: "sticky", top: 0, zIndex: 2, background: C.card,
          padding: "20px 0 14px", marginBottom: 10,
          borderBottom: `1px solid ${C.border}`
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: C.titleColor || C.text }}>{title}</h2>
          <button onClick={onClose} aria-label="閉じる" style={{
            color: C.textMuted, width: 44, height: 44,
            display: "flex", alignItems: "center", justifyContent: "center"
          }}><Icon name="x" size={20} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

// ─── トリガー習慣行 ───────────────────────────────────────────────
function TriggerRow({ triggerHabit, todayLog, onToggle }) {
const done = todayLog && !todayLog.is_reverted;
const [anim, setAnim] = useState(false);
const [chainAnim, setChainAnim] = useState(false); // 連鎖アニメーション

const handleToggle = () => {
setAnim(true);
setTimeout(() => setAnim(false), 300);
if (!done) {
// 未→完了: 連鎖演出を起動（少し遅延させて完了アニメの後に表示）
setTimeout(() => { setChainAnim(true); }, 350);
setTimeout(() => { setChainAnim(false); }, 2200);
}
onToggle();
};

return (
<div style={{ marginBottom: 0 }}>
{/* 他の習慣との間隔 + アクセントライン */}
<div style={{
height: 1,
marginTop: 14,
background: `linear-gradient(90deg, ${C.accent}30, transparent)`,
}} />
{/* タスク行（通常TaskRowに準じたレイアウト） */}
<div style={{
display: "flex",
alignItems: "center",
gap: 14,
padding: "10px 20px",
borderBottom: `1px solid ${C.border}`,
background: done ? C.accentDim.replace("0.1)", "0.04)").replace("0.12)", "0.04)") : "transparent",
transition: "background 0.3s ease",
}}>
<button
onClick={handleToggle}
className={anim ? "check-pop" : ""}
style={{
width: 44, height: 44, borderRadius: 10,
border: "none", background: "transparent",
display: "flex", alignItems: "center", justifyContent: "center",
flexShrink: 0,
}}
>
<span aria-hidden="true" style={{
width: 28, height: 28, borderRadius: 7,
border: `2px solid ${done ? C.accent : C.checkboxBorder}`,
background: done ? C.accentDim : "transparent",
display: "flex", alignItems: "center", justifyContent: "center",
transition: "all 0.2s ease", pointerEvents: "none",
boxShadow: done ? `0 0 10px ${C.accentGlow}` : "none",
}}>
{done && <Icon name="check" size={15} color={C.accent} />}
</span>
</button>
<div style={{ flex: 1, minWidth: 0 }}>
<div style={{
fontSize: 15, fontWeight: 400,
color: done ? C.textMuted : C.text,
textDecoration: done ? "line-through" : "none",
textDecorationColor: C.border,
whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
transition: "color 0.2s",
}}>{triggerHabit.name}</div>
<div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
<span style={{ fontSize: 9, color: C.accent, opacity: 0.6 }}>◈</span>
<span style={{ fontSize: 11, color: C.textDim }}>トリガー・XPなし</span>
</div>
</div>
</div>
{/* 連鎖メッセージ */}
{chainAnim && (
<div className="fade-up" style={{
padding: "8px 20px 6px",
display: "flex", alignItems: "center", gap: 6,
borderBottom: `1px solid ${C.border}`,
}}>
<span style={{ fontSize: 10, color: C.accent, opacity: 0.6 }}>◈</span>
<span style={{ fontSize: 12, color: C.textMuted }}>さあ、今日のリストを確認しよう</span>
</div>
)}
</div>
);
}

// ─── 習慣フォーム ─────────────────────────────────────────────────
function HabitForm({ initial, onSave, onCancel }) {
const [name, setName] = useState(initial?.name || "");
const [freq, setFreq] = useState(initial?.frequency || "daily");
// 週次(1曜日): day_of_week (number)
const [dow, setDow] = useState(initial?.day_of_week ?? 1);
// 週N回: days_of_week (array)
const [daysOfWeek, setDaysOfWeek] = useState(
Array.isArray(initial?.days_of_week) ? initial.days_of_week : [1]
);
const [time, setTime] = useState(initial?.notify_time || "08:00");

const toggleDow = (i) => {
setDaysOfWeek(prev =>
prev.includes(i)
? prev.length > 1 ? prev.filter(d => d !== i) : prev  // 最低1つ選択必須
: [...prev, i].sort((a, b) => a - b)
);
};

const handleSave = () => {
if (!name.trim()) return;
onSave({
name: name.trim(),
frequency: freq,
day_of_week: freq === "weekly" ? dow : null,
days_of_week: freq === "weekly_n" ? daysOfWeek : null,
notify_time: time,
});
};

const Label = ({ children }) => (
<div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6, letterSpacing: "0.04em" }}>{children}</div>
);
const DowBtn = ({ i, selected, onPress }) => (
<button
key={i}
onClick={() => onPress(i)}
style={{
width: 44, height: 44, borderRadius: 10,
border: `1px solid ${selected ? C.accent : C.border}`,
background: selected ? C.accentDim : "transparent",
color: selected ? C.accent : C.textMuted,
fontSize: 13, transition: "all 0.15s",
}}
>{DOW_LABELS[i]}</button>
);

return (
<div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
<div>
<Label>習慣名</Label>
<input value={name} onChange={e => setName(e.target.value)} placeholder="例：朝の散歩" maxLength={30} inputMode="text" enterKeyHint="done" />
</div>
<div>
<Label>頻度</Label>
<select value={freq} onChange={e => setFreq(e.target.value)}>
<option value="daily">毎日</option>
<option value="weekly">週1回（曜日指定）</option>
<option value="weekly_n">週N回（複数曜日）</option>
</select>
</div>
{freq === "weekly" && (
<div>
<Label>実施曜日</Label>
<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
{DOW_LABELS.map((_, i) => (
<DowBtn key={i} i={i} selected={dow === i} onPress={setDow} />
))}
</div>
</div>
)}
{freq === "weekly_n" && (
<div>
<Label>実施曜日（複数選択可）</Label>
<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
{DOW_LABELS.map((_, i) => (
<DowBtn key={i} i={i} selected={daysOfWeek.includes(i)} onPress={toggleDow} />
))}
</div>
<div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>
週{daysOfWeek.length}回のペースで実施します
</div>
</div>
)}
<div>
<Label>実施予定時刻</Label>
<input type="time" value={time} onChange={e => setTime(e.target.value)} />
</div>
<div style={{ display: "flex", gap: 10, marginTop: 4 }}>
<button
onClick={onCancel}
style={{
flex: 1, padding: "12px", borderRadius: 12,
border: `1px solid ${C.border}`, color: C.textMuted, fontSize: 14,
}}
>キャンセル</button>
<button
onClick={handleSave}
style={{
flex: 2, padding: "12px", borderRadius: 12,
background: name.trim() ? C.accentDim : C.cardAlt,
border: `1px solid ${name.trim() ? C.accent + "66" : C.border}`,
color: name.trim() ? C.accent : C.textDim,
fontSize: 14, fontWeight: 500, transition: "all 0.2s",
}}
>保存する</button>
</div>
</div>
);
}

// ─── 習慣管理画面 ─────────────────────────────────────────────────
function HabitsScreen({ habits, logs, offset = 0, onAdd, onEdit, onDelete, onToggleActive, onGraduate, onReactivate }) {
const [showForm, setShowForm] = useState(false);
const [editTarget, setEditTarget] = useState(null);
const [deleteConfirm, setDeleteConfirm] = useState(null);
const [graduateConfirm,setGraduateConfirm]=useState(null);
const logicalToday=getLogicalDate(offset);

const activeCount = habits.filter(h => h.is_active).length;
const atMax = activeCount >= 5;
// 作業中→一時停止→卒業済み。各グループでは登録順を保存する。
const orderedHabits = habits.map((habit, index) => ({ habit, index }))
  .sort((a, b) => {
    const priority = h => h.graduated_at ? 2 : h.is_active ? 0 : 1;
    return priority(a.habit) - priority(b.habit) || a.index - b.index;
  }).map(item => item.habit);
const firstGraduatedId = orderedHabits.find(h => !!h.graduated_at)?.id;

const handleAdd = (data) => {
onAdd(data);
setShowForm(false);
};
const handleEdit = (data) => {
onEdit(editTarget.id, data);
setEditTarget(null);
};

return (
<div className="pon-scroll" style={{ height: "100%", minHeight: 0, overflowY: "auto", paddingBottom: 24 }}>
{/* ヘッダー */}
<div style={{
padding: "20px 20px 16px",
display: "flex",
alignItems: "center",
justifyContent: "space-between",
position: "sticky",
top: 0,
background: C.bg,
zIndex: 10,
borderBottom: `1px solid ${C.border}`,
}}>
<div>
<div style={{ fontSize: 16, fontWeight: 500, color: C.titleColor || C.text }}>習慣管理</div>
<div style={{ fontSize: 11, color: C.textDim, marginTop: 2, fontFamily: "'DM Mono', monospace" }}>
{activeCount}/5 件有効
</div>
</div>
<button
onClick={() => !atMax && setShowForm(true)}
style={{
display: "flex",
alignItems: "center",
gap: 6,
padding: "8px 14px",
borderRadius: 12,
border: `1px solid ${atMax ? C.border : C.accent + "55"}`,
background: atMax ? "transparent" : C.accentDim,
color: atMax ? C.textDim : C.accent,
fontSize: 13,
transition: "all 0.2s",
}}
>
<Icon name="plus" size={16} />
追加
</button>
</div>


  {atMax && (
    <div className="fade-up" style={{
      margin: "12px 16px",
      padding: "12px 16px",
      background: C.dangerDim,
      border: `1px solid ${C.danger}33`,
      borderRadius: 12,
      fontSize: 13,
      color: "#fca5a5",
    }}>
      最大5件まで登録できます。<br />使わない習慣を無効化または削除してください。
    </div>
  )}

  {habits.length === 0 && (
    <div className="fade-up" style={{ padding: "48px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 14, color: C.textMuted }}>習慣がまだないね。追加してみよう。</div>
    </div>
  )}

  {orderedHabits.map(h => (
    <div key={h.id}>
      {h.id === firstGraduatedId && (
        <div style={{margin:"24px 20px 10px",paddingTop:12,borderTop:`1px solid ${C.border}`,fontSize:12,color:C.textMuted}}>
          🏅 卒業した習慣
        </div>
      )}
    <div className="fade-up" style={{
      margin: "10px 16px",
      background: C.card,
      borderRadius: 14,
      border: `1px solid ${h.is_active ? C.border : C.cardAlt}`,
      overflow: "hidden",
      opacity: h.is_active || h.graduated_at ? 1 : 0.5,
      transition: "opacity 0.2s",
    }}>
      <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 400, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {h.name}
          </div>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 3 }}>
            {h.frequency === "daily" ? "毎日"
            : h.frequency === "weekly_n"
            ? `週${(h.days_of_week || []).length}回（${(h.days_of_week || []).map(d => DOW_LABELS[d]).join("・")}）`
            : `毎週${DOW_LABELS[h.day_of_week]}`}
            {h.notify_time && <span style={{ marginLeft: 8 }}>{h.notify_time}</span>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={() => onToggleActive(h.id)}
            disabled={!!h.graduated_at}
            style={{ color: h.is_active ? C.accent : C.textDim, transition: "color 0.2s" }}
            title={h.is_active ? "無効化" : "有効化"}
          >
            <Icon name={h.is_active ? "toggle_on" : "toggle_off"} size={28} />
          </button>
          <button
            onClick={() => setEditTarget(h)}
            style={{ color: C.textMuted, padding: 4 }}
          >
            <Icon name="edit" size={16} />
          </button>
          <button
            onClick={() => setDeleteConfirm(h.id)}
            style={{ color: C.textDim, padding: 4 }}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </div>
      {h.graduated_at ? (
        <div style={{padding:"0 16px 14px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span style={{fontSize:12,color:C.accent}}>🏅 卒業済み</span>
          <button onClick={()=>onReactivate(h.id)} disabled={atMax}
            style={{padding:"9px 12px",color:atMax?C.textDim:C.accent,borderRadius:9,border:`1px solid ${C.border}`}}>
            {atMax?"5件上限のため再開不可":"もう一度取り組む"}
          </button>
        </div>
      ) : h.is_active && isHabitScheduledOnDate(h,logicalToday) && hasHabitDone(logs,h.id,logicalToday) ? (
        <div style={{padding:"0 16px 14px",textAlign:"right"}}>
          <button onClick={()=>setGraduateConfirm(h.id)} style={{padding:"10px 14px",borderRadius:10,color:C.accent,background:C.accentDim,border:`1px solid ${C.accent}44`}}>✦ この習慣を卒業する</button>
        </div>
      ) : null}
    </div>
    </div>
  ))}

  {showForm && (
    <Modal title="習慣を追加" onClose={() => setShowForm(false)}>
      <HabitForm onSave={handleAdd} onCancel={() => setShowForm(false)} />
    </Modal>
  )}
  {editTarget && (
    <Modal title="習慣を編集" onClose={() => setEditTarget(null)}>
      <HabitForm initial={editTarget} onSave={handleEdit} onCancel={() => setEditTarget(null)} />
    </Modal>
  )}
  {graduateConfirm && (
    <Modal title="卒業の確認" onClose={()=>setGraduateConfirm(null)}>
      <p style={{fontSize:14,color:C.text,lineHeight:1.8,marginBottom:16}}>
        今日の達成、おめでとう！<br/>この習慣を卒業して表彰棚に残す？<br/>
        <span style={{fontSize:12,color:C.textMuted}}>今日のXPと実績はそのまま。次の論理日からタスク対象外になるよ。</span>
      </p>
      <div style={{display:"flex",gap:10}}>
        <button style={modalBtnStyle("cancel")} onClick={()=>setGraduateConfirm(null)}>まだ続ける</button>
        <button style={modalBtnStyle("save")} onClick={()=>{onGraduate(graduateConfirm);setGraduateConfirm(null);}}>卒業する</button>
      </div>
    </Modal>
  )}
  {deleteConfirm && (
    <Modal title="削除の確認" onClose={() => setDeleteConfirm(null)}>
      <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.7, marginBottom: 20 }}>
        この習慣を削除しますか？<br />
        <span style={{ fontSize: 12, color: C.textDim }}>過去の記録は残ります。</span>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={() => setDeleteConfirm(null)} style={modalBtnStyle("cancel")}>キャンセル</button>
        <button onClick={() => { onDelete(deleteConfirm); setDeleteConfirm(null); }} style={modalBtnStyle("danger")}>削除する</button>
      </div>
    </Modal>
  )}
</div>

);
}

// ─── 履歴画面 ─────────────────────────────────────────────────────
function HistoryScreen({ habits, logs, offset = 0, triggerHabit, triggerLogs, graduations = [], recoveryEvents = [], onReactivate }) {
const [selected, setSelected] = useState(null);
const [reactivateTarget,setReactivateTarget]=useState(null);
const atActiveCap=habits.filter(h=>h.is_active&&!h.deleted).length>=5;

useEffect(() => {
if (!selected) {
if (triggerHabit) setSelected("__trigger__");
else if (habits.length > 0) setSelected(habits[0].id);
}
}, [habits, triggerHabit]);

const isTriggerSelected = selected === "__trigger__";
const habit = isTriggerSelected
? (triggerHabit ? { ...triggerHabit, frequency: "daily" } : null)
: habits.find(h => h.id === selected);

// ログ取得（トリガー選択時はtriggerLogsから）
const habitLogs = isTriggerSelected
? (triggerLogs || []).filter(l => !l.is_reverted).sort((a, b) => {
const aKey = a.completed_at || a.executed_date;
const bKey = b.completed_at || b.executed_date;
return bKey.localeCompare(aKey);
})
: logs
.filter(l => l.habit_id === selected && !l.is_reverted && !l.is_bonus)
.sort((a, b) => {
const aKey = a.completed_at || a.executed_date;
const bKey = b.completed_at || b.executed_date;
return bKey.localeCompare(aKey);
});

// 累計
const totalCount = habitLogs.length;
const lastLog = habitLogs[0];
const lastDate = lastLog?.executed_date;
const recoveries=recoveryEvents.filter(e=>e.habit_id===selected&&!e.is_reverted).length;

// 連続日数：offset考慮・当日完了状態をリアルタイム反映
let streak = 0;
const todayStrH = getLogicalDate(offset);
if (habit?.frequency === "daily") {
const dates = new Set(habitLogs.map(l => l.executed_date));
let cur = new Date(todayStrH + "T12:00:00");
while (true) {
const s = localDateKey(cur);
if (dates.has(s)) { streak++; cur.setDate(cur.getDate() - 1); }
else break;
}
} else if (habit?.frequency === "weekly_n") {
const wanted=(habit.days_of_week||[]).length;
let end=addDateDays(todayStrH,-(fromDateKey(todayStrH).getDay()+1));
const completedDates=new Set(habitLogs.map(l=>l.executed_date));
while(wanted>0 && streak<10000){
  const start=addDateDays(end,-6);let count=0;
  for(let day=start;day<=end;day=addDateDays(day,1)){
    if((habit.days_of_week||[]).includes(fromDateKey(day).getDay())&&completedDates.has(day))count++;
  }
  if(count!==wanted)break;
  streak++;end=addDateDays(start,-1);
}
}

// 達成日時のフォーマット（西暦〜時刻まで）
const formatCompletedAt = (isoStr) => {
if (!isoStr) return null;
const d = new Date(isoStr);
const yy = d.getFullYear();
const mo = String(d.getMonth() + 1).padStart(2, "0");
const dd = String(d.getDate()).padStart(2, "0");
const dow = DOW_LABELS[d.getDay()];
const hh = String(d.getHours()).padStart(2, "0");
const mm = String(d.getMinutes()).padStart(2, "0");
return { date: `${yy}/${mo}/${dd}（${dow}）`, time: `${hh}:${mm}` };
};

const formatDate = (s) => {
const d = fromDateKey(s);
return `${d.getMonth() + 1}月${d.getDate()}日（${DOW_LABELS[d.getDay()]}）`;
};

return (
<div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
{/* 卒業ダッシュボード。卒業中のみ1習慣1枚表示 */}
{graduations.length>0 && (
  <div style={{padding:"14px 16px",borderBottom:`1px solid ${C.border}`,maxHeight:240,overflowY:"auto"}}>
    <div style={{fontSize:13,color:C.titleColor||C.text,fontWeight:600,marginBottom:10}}>✦ 卒業ダッシュボード</div>
    {graduations.map(g=>{
      const h=habits.find(v=>v.id===g.habit_id);
      if(!h||!h.graduated_at)return null;
      const labels={bronze:"BRONZE",silver:"SILVER",gold:"GOLD",platinum:"PLATINUM"};
      const colors={bronze:"#B77745",silver:"#94A3B8",gold:"#D5A329",platinum:"#A78BFA"};
      return <div key={g.habit_id} style={{border:`1px solid ${C.border}`,borderRadius:12,padding:12,marginBottom:8,background:C.card}}>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <span style={{fontSize:28,color:colors[g.rank]||C.accent}}>🏅</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,color:C.text}}>{h.name}</div>
            <div style={{fontSize:11,color:colors[g.rank]||C.accent,fontWeight:600}}>{labels[g.rank]||"BRONZE"} · {g.completion_count}回達成</div>
            <div style={{fontSize:10,color:C.textDim}}>{g.graduated_at?localDateKey(new Date(g.graduated_at)):""} 卒業</div>
          </div>
          <button onClick={()=>setReactivateTarget(g.habit_id)} disabled={atActiveCap} style={{fontSize:11,padding:8,color:atActiveCap?C.textDim:C.accent,border:`1px solid ${C.border}`,borderRadius:8}}>再開</button>
        </div>
      </div>;
    })}
  </div>
)}
{reactivateTarget&&(
  <Modal title="習慣を再開" onClose={()=>setReactivateTarget(null)}>
    <div style={{color:C.text,fontSize:13,lineHeight:1.8,marginBottom:16}}>再開すると表彰棚からカードが消えるよ。これまでのXPと記録は残る。</div>
    <div style={{display:"flex",gap:10}}>
      <button onClick={()=>setReactivateTarget(null)} style={modalBtnStyle("cancel")}>キャンセル</button>
      <button disabled={atActiveCap} onClick={()=>{onReactivate(reactivateTarget);setReactivateTarget(null);}} style={{...modalBtnStyle("save"),color:atActiveCap?C.textDim:C.accent}}>{atActiveCap?"有効5件のため再開不可":"再開する"}</button>
    </div>
  </Modal>
)}
{/* ヘッダー */}
<div style={{
padding: "20px 20px 14px",
borderBottom: `1px solid ${C.border}`,
background: C.bg,
}}>
<div style={{ fontSize: 16, fontWeight: 500, color: C.titleColor || C.text, marginBottom: 12 }}>実行履歴</div>
<select
value={selected || ""}
onChange={e => setSelected(e.target.value)}
style={{ fontSize: 14 }}
>
{triggerHabit && (
<option value="__trigger__">◈ {triggerHabit.name}（トリガー）</option>
)}
{habits.map(h => (
<option key={h.id} value={h.id}>
{h.name}{h.deleted ? "（削除済み）" : ""}
</option>
))}
</select>
</div>


  {/* 実行による復帰マーク。再開のみではXPを加算しない。 */}
  {!isTriggerSelected&&habit&&recoveries>0&&(
    <div style={{padding:"8px 16px",fontSize:11,color:C.accent}}>◈ 復帰マーク {recoveries}回</div>
  )}
  {/* 集計 */}
  {habit && (
    <div style={{
      display: "flex",
      gap: 10,
      padding: "14px 16px",
      borderBottom: `1px solid ${C.border}`,
    }}>
      {[
        { label: "連続", value: habit.frequency === "daily" ? `${streak}日` : habit.frequency === "weekly_n" ? `${streak}週` : "—" },
        { label: "累計", value: `${totalCount}回` },
        { label: "最終日", value: lastDate ? formatDate(lastDate) : "なし" },
      ].map(({ label, value }) => (
        <div key={label} style={{
          flex: 1,
          background: C.card,
          borderRadius: 12,
          border: `1px solid ${C.border}`,
          padding: "10px 12px",
          textAlign: "center",
        }}>
          <div style={{ fontSize: 10, color: C.textDim, marginBottom: 4, letterSpacing: "0.04em" }}>{label}</div>
          <div style={{ fontSize: 13, color: C.text, fontFamily: "'DM Mono', monospace", fontWeight: 500 }}>{value}</div>
        </div>
      ))}
    </div>
  )}

  {/* 履歴一覧 */}
  <div style={{ flex: 1, overflowY: "auto" }}>
    {habits.length === 0 && !triggerHabit ? (
      <div style={{ padding: "48px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 14, color: C.textMuted }}>習慣がまだないよ。</div>
      </div>
    ) : habitLogs.length === 0 ? (
      <div className="fade-up" style={{ padding: "48px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 14, color: C.textMuted }}>
          まだ記録がないね。<br />1回こなしたら、ここに積まれていくよ。
        </div>
      </div>
    ) : habitLogs.map(l => {
      const dt = formatCompletedAt(l.completed_at);
      return (
        <div key={l.id} style={{
          padding: "12px 20px",
          borderBottom: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}>
          <div style={{
            width: 5, height: 5, borderRadius: "50%",
            background: C.accent,
            opacity: 0.5,
            flexShrink: 0,
            marginTop: 1,
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {dt ? (
              <>
                <div style={{ fontSize: 14, color: C.text }}>{dt.date}</div>
                <div style={{
                  fontSize: 11,
                  color: C.textDim,
                  fontFamily: "'DM Mono', monospace",
                  marginTop: 2,
                }}>{dt.time}</div>
              </>
            ) : (
              <div style={{ fontSize: 14, color: C.text }}>{formatDate(l.executed_date)}</div>
            )}
          </div>
          {l.xp_gained > 0 && (
            <div style={{
              fontSize: 11,
              color: C.accent,
              fontFamily: "'DM Mono', monospace",
              opacity: 0.65,
              flexShrink: 0,
            }}>+{l.xp_gained} XP</div>
          )}
        </div>
      );
    })}
  </div>
</div>

);
}

// ─── トリガー習慣エディター ──────────────────────────────────────
function TriggerHabitEditor({ triggerHabit, onSave }) {
const [editing, setEditing] = useState(false);
const [name, setName] = useState(triggerHabit?.name || "");

const handleSave = () => {
if (!name.trim()) return;
onSave({ id: triggerHabit?.id || `trigger-${Date.now()}`, name: name.trim() });
setEditing(false);
};
const handleDelete = () => {
onSave(null);
setName("");
setEditing(false);
};

if (!triggerHabit && !editing) {
return (
<button
onClick={() => setEditing(true)}
style={{
display: "flex", alignItems: "center", gap: 6,
padding: "9px 14px", borderRadius: 10,
border: `1px solid ${C.accent}44`,
background: C.accentDim, color: C.accent, fontSize: 13,
}}
>
<span>＋</span> トリガー習慣を登録する
</button>
);
}

if (editing) {
return (
<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
<input
value={name}
onChange={e => setName(e.target.value)}
placeholder="例：歯磨き・コーヒーを飲む"
maxLength={30}
autoFocus
style={{ fontSize: 14 }}
/>
<div style={{ display: "flex", gap: 8 }}>
<button
onClick={() => { setEditing(false); setName(triggerHabit?.name || ""); }}
style={{ flex: 1, padding: "10px", borderRadius: 10, border: `1px solid ${C.border}`, color: C.textMuted, fontSize: 13 }}
>キャンセル</button>
<button
onClick={handleSave}
style={{ flex: 2, padding: "10px", borderRadius: 10, background: name.trim() ? C.accentDim : "transparent", border: `1px solid ${name.trim() ? C.accent + "66" : C.border}`, color: name.trim() ? C.accent : C.textDim, fontSize: 13, fontWeight: 500 }}
>保存する</button>
</div>
</div>
);
}

return (
<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
<div style={{
flex: 1, padding: "10px 14px", borderRadius: 10,
border: `1px solid ${C.accent}33`, background: C.accentDim,
fontSize: 14, color: C.text,
}}>
<span style={{ fontSize: 10, color: C.accent, marginRight: 6 }}>◈</span>
{triggerHabit.name}
</div>
<button
onClick={() => { setName(triggerHabit.name); setEditing(true); }}
style={{ color: C.textMuted, padding: 6 }}
><Icon name="edit" size={16} /></button>
<button onClick={handleDelete} style={{ color: C.textDim, padding: 6 }}>
<Icon name="trash" size={16} />
</button>
</div>
);
}

// ─── 設定画面サブコンポーネント（トップレベルで定義してレンダリング時に再生成されないようにする）
function SettingsCard({ children }) {
return (
<div style={{ background: C.card, borderRadius: 14, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 16 }}>
{children}
</div>
);
}
function SettingsCardTitle({ children }) {
return (
<div style={{ padding: "14px 18px 10px", borderBottom: `1px solid ${C.border}` }}>
<div style={{ fontSize: 13, fontWeight: 500, color: C.text, letterSpacing: "0.02em" }}>{children}</div>
</div>
);
}
function SettingsSaveBtn({ onClick, disabled }) {
return (
<button
onClick={onClick}
disabled={disabled}
style={{
padding: "10px 16px",
borderRadius: 10,
border: `1px solid ${disabled ? C.border : C.accent + "55"}`,
background: disabled ? "transparent" : C.accentDim,
color: disabled ? C.textDim : C.accent,
fontSize: 13,
flexShrink: 0,
transition: "all 0.15s",
cursor: disabled ? "default" : "pointer",
}}
>保存</button>
);
}
function SettingsCurrentLabel({ label }) {
return (
<div style={{ fontSize: 11, color: C.textDim, marginTop: 8, fontFamily: "'DM Mono', monospace" }}>
現在: {label}
</div>
);
}

// ─── 設定画面 ─────────────────────────────────────────────────────
function SettingsScreen({ settings, onSave, logs, onResetTodayLogs, partnerInput, onPartnerInputChange, onPreviewTheme, triggerHabit, onSaveTrigger }) {
// ─── パートナー名（App側stateで保持してタブ切り替えでもリセットされない）───
const [partnerError, setPartnerError] = useState("");
const FORBIDDEN_RE = /[<>&"'`\\\/\x00-\x1f\x7f]/; const FORBIDDEN_DESC = '< > & " \' ` \ /';

const handlePartnerChange = (v) => {
if (FORBIDDEN_RE.test(v)) {
setPartnerError(`使用できない文字が含まれています: ${FORBIDDEN_DESC}`);
return;
}
if (v.length > 6) return;
setPartnerError("");
onPartnerInputChange(v);
};
const handlePartnerSave = () => {
const name = partnerInput.trim() || "ぽん";
onPartnerInputChange(name);
onSave({ ...settings, partner_name: name });
};

// ─── デザイン ───────────────────────────────────────────────────
const themeOptions = [
{ id: "dark",  label: "シック・ナイト（デフォルト）" },
{ id: "light", label: "クリア・オーシャン" },
{ id: "warm",  label: "ソフト・ブロッサム" },
];
const [pendingTheme, setPendingTheme] = useState(settings.theme || "dark");
const currentThemeLabel = themeOptions.find(t => t.id === (settings.theme || "dark"))?.label || "";
const handleThemeSelect = (id) => {
setPendingTheme(id);
onPreviewTheme(id);  // プレビュー適用（保存前）
};
const handleThemeSave = () => {
onSave({ ...settings, theme: pendingTheme });
onPreviewTheme(null); // プレビュー解除（保存確定）
};

// ─── 日付更新 ───────────────────────────────────────────────────
const offset = settings.day_start_hour ?? 0;
const hourOptions = [0,1,2,3,4,5,6];
const [pendingHour, setPendingHour] = useState(offset);
const [confirmHour, setConfirmHour] = useState(null);
const [hourWarned, setHourWarned]   = useState(false);

const hasTodayDone = (targetOffset) => {
const todayStr = getLogicalDate(targetOffset);
return logs.some(l => l.executed_date === todayStr && !l.is_reverted && !l.is_bonus);
};

const handleHourSelectChange = (h) => {
if (hasTodayDone(offset) || hasTodayDone(h)) {
setConfirmHour(h);
} else {
setPendingHour(h);
setHourWarned(false);
}
};

const handleHourConfirm = () => {
setPendingHour(confirmHour);
setHourWarned(true);
setConfirmHour(null);
};

const handleHourSave = () => {
if (pendingHour === offset) return;
onResetTodayLogs(pendingHour);
setHourWarned(false);
};

const hourLabel = (h) => h === 0 ? "0:00（標準）" : `${h}:00`;

// サブコンポーネントはトップレベルで定義済み（SettingsCard等）

return (
<div style={{ height: "100%", overflowY: "auto", paddingBottom: 40 }}>
<div style={{ padding: "20px 20px 16px", borderBottom: `1px solid ${C.border}` }}>
<div style={{ fontSize: 16, fontWeight: 500, color: C.titleColor || C.text }}>設定</div>
</div>


  <div style={{ padding: "20px 16px 0" }}>

    {/* ─── トリガー習慣 ─── */}
    <SettingsCard>
      <SettingsCardTitle>トリガー習慣</SettingsCardTitle>
      <div style={{ padding: "14px 16px" }}>
        <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12, lineHeight: 1.7 }}>
          すでに習慣になっていることを登録しておくと、アプリを開くきっかけになります。<br />
          XPや全クリボーナスには影響しません。1つだけ登録できます。
        </div>
        <TriggerHabitEditor triggerHabit={triggerHabit} onSave={onSaveTrigger} />
      </div>
    </SettingsCard>

    {/* ─── パートナー ─── */}
    <SettingsCard>
      <SettingsCardTitle>パートナー</SettingsCardTitle>
      <div style={{ padding: "14px 16px" }}>
        <div style={{ fontSize: 12, color: C.textDim, marginBottom: 10, lineHeight: 1.6 }}>
          コメントに登場する名前を設定します。6文字以内で入力してください。
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={partnerInput}
            onChange={e => handlePartnerChange(e.target.value)}
            placeholder="ぽん"
            maxLength={6}
            style={{ flex: 1, fontSize: 14 }}
          />
          <SettingsSaveBtn onClick={handlePartnerSave} disabled={false} />
        </div>
        {partnerError && (
          <div style={{ fontSize: 11, color: C.danger, marginTop: 6, lineHeight: 1.6 }}>
            {partnerError}
          </div>
        )}
        <SettingsCurrentLabel label={settings.partner_name || "ぽん"} />
      </div>
    </SettingsCard>

    {/* ─── デザイン ─── */}
    <SettingsCard>
      <SettingsCardTitle>デザイン</SettingsCardTitle>
      <div style={{ padding: "12px 16px 14px" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <select
            value={pendingTheme}
            onChange={e => handleThemeSelect(e.target.value)}
            style={{ flex: 1, fontSize: 14 }}
          >
            {themeOptions.map(t => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <SettingsSaveBtn onClick={handleThemeSave} disabled={pendingTheme === (settings.theme || "dark")} />
        </div>
        <SettingsCurrentLabel label={currentThemeLabel} />
      </div>
    </SettingsCard>

    {/* ─── 日付更新 ─── */}
    <SettingsCard>
      <SettingsCardTitle>日付更新</SettingsCardTitle>
      <div style={{ padding: "12px 16px 14px" }}>
        <div style={{ fontSize: 12, color: C.textDim, marginBottom: 10, lineHeight: 1.6 }}>
          この時刻より前の操作は前日扱いになります。夜ふかし派の方は遅めに設定してください。
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select
            value={pendingHour}
            onChange={e => handleHourSelectChange(Number(e.target.value))}
            style={{ flex: 1, fontSize: 14 }}
          >
            {hourOptions.map(h => (
              <option key={h} value={h}>{hourLabel(h)}</option>
            ))}
          </select>
          <SettingsSaveBtn onClick={handleHourSave} disabled={pendingHour === offset} />
        </div>
        {hourWarned && (
          <div style={{ fontSize: 11, color: C.danger, marginTop: 8, lineHeight: 1.6 }}>
            ⚠ 保存すると当日の達成記録とXPがリセットされます。
          </div>
        )}
        <div style={{ fontSize: 11, color: C.textDim, marginTop: 8, lineHeight: 1.6 }}>
          ※ 変更しても過去の履歴は変わりません。
        </div>
        <SettingsCurrentLabel label={hourLabel(offset)} />
      </div>
    </SettingsCard>

  </div>

  {/* 注意モーダル（セレクト変更時・達成済みあり） */}
  {confirmHour !== null && (
    <Modal title="日付更新の変更確認" onClose={() => setConfirmHour(null)}>
      <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.8, marginBottom: 20 }}>
        今日の達成記録がある状態で変更すると、<br />
        <span style={{ color: C.text }}>保存時に当日分の達成記録とXPがすべてリセット</span>されます。<br />
        <br />
        <span style={{ fontSize: 12, color: C.textDim }}>
          XPの二重取りを防ぐための仕様です。<br />
          内容を確認のうえ、保存ボタンを押してください。
        </span>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={() => setConfirmHour(null)} style={modalBtnStyle("cancel")}>キャンセル</button>
        <button onClick={handleHourConfirm} style={modalBtnStyle("danger")}>確認して続ける</button>
      </div>
    </Modal>
  )}
</div>

);
}

// ─── ナビゲーション ───────────────────────────────────────────────
function NavBar({ tab, onTab }) {
const items = [
{ id: "home", icon: "home", label: "ホーム" },
{ id: "habits", icon: "list", label: "習慣" },
{ id: "history", icon: "history", label: "履歴" },
{ id: "settings", icon: "bell", label: "設定" },
];
return (
<div style={{
display: "flex", flexShrink: 0,
borderTop: `1px solid ${C.border}`,
background: C.card,
paddingBottom: "max(4px, env(safe-area-inset-bottom, 0px))",
}}>
{items.map(item => {
const active = tab === item.id;
return (
<button
key={item.id}
onClick={() => onTab(item.id)}
style={{
flex: 1,
padding: "10px 0 14px",
display: "flex",
flexDirection: "column",
alignItems: "center",
gap: 4,
color: active ? C.accent : C.textDim,
transition: "color 0.15s",
position: "relative",
}}
>
{active && (
<div style={{
position: "absolute",
top: 0,
left: "50%",
transform: "translateX(-50%)",
width: 28,
height: 2,
borderRadius: "0 0 4px 4px",
background: C.accent,
boxShadow: `0 0 8px ${C.accentGlow}`,
}} />
)}
<Icon name={item.icon} size={20} />
<span style={{ fontSize: 10, letterSpacing: "0.02em" }}>{item.label}</span>
</button>
);
})}
</div>
);
}

// ─── メインアプリ v6 ─────────────────────────────────────────────
export default function App() {
  const [habits,setHabits]=useState(()=>load(STORAGE_KEYS.habits,[]));
  const [logs,setLogs]=useState(()=>load(STORAGE_KEYS.logs,[]));
  const [userStatus,setUserStatus]=useState(()=>load(STORAGE_KEYS.status,{total_xp:0,level:1,last_opened_at:null}));
  const [settings,setSettings]=useState(()=>load(STORAGE_KEYS.settings,{day_start_hour:0,theme:"dark",partner_name:"ぽん"}));
  const [triggerHabit,setTriggerHabit]=useState(()=>load(STORAGE_KEYS.trigger,null));
  const [triggerLogs,setTriggerLogs]=useState(()=>load(STORAGE_KEYS.trigger_logs,[]));
  const [graduations,setGraduations]=useState(()=>load(STORAGE_KEYS.graduations,[]));
  const [recoveryEvents,setRecoveryEvents]=useState(()=>load(STORAGE_KEYS.recovery_events,[]));
  const [tab,setTab]=useState("home");
  const [prevXp,setPrevXp]=useState(userStatus.total_xp);
  const [levelUpInfo,setLevelUpInfo]=useState(null);
  const prevLevelRef=useRef(calcLevel(userStatus.total_xp).level);
  const [showWeeklyReview,setShowWeeklyReview]=useState(false);
  const [returningDays,setReturningDays]=useState(null);
  const [firstNotice,setFirstNotice]=useState(false);
  const [clockTick,setClockTick]=useState(0);
  // The visual viewport may be narrower than the layout viewport after iOS page zoom.
  const [screenViewport,setScreenViewport]=useState(getModalViewport);
  useEffect(()=>{
    const viewport=window.visualViewport;
    const update=()=>{
      const next=getModalViewport();
      setScreenViewport(previous=>
        previous.left===next.left && previous.top===next.top &&
        previous.width===next.width && previous.height===next.height &&
        previous.scale===next.scale ? previous : next
      );
    };
    viewport?.addEventListener("resize",update);
    viewport?.addEventListener("scroll",update);
    window.addEventListener("resize",update);
    update();
    return ()=>{
      viewport?.removeEventListener("resize",update);
      viewport?.removeEventListener("scroll",update);
      window.removeEventListener("resize",update);
    };
  },[]);
  useEffect(()=>{if(!firstNotice)return;const t=setTimeout(()=>setFirstNotice(false),2600);return()=>clearTimeout(t);},[firstNotice]);
  const offset=settings.day_start_hour??0;
  // 時間経過とともに論理日付を更新する（タブを開いたままでも朝のタスクが切り替わる）。
  useEffect(()=>{const id=setInterval(()=>setClockTick(t=>t+1),60000);return()=>clearInterval(id);},[]);
  const dateKey=getLogicalDate(offset); // clockTickで毎分再レンダリング
  const currentTheme=getTheme(settings.theme??"dark");
  const partnerName=settings.partner_name||"ぽん";
  const [previewThemeId,setPreviewThemeId]=useState(null);
  const activeTheme=previewThemeId?getTheme(previewThemeId):currentTheme;
  C=activeTheme;
  const [partnerInput,setPartnerInput]=useState(settings.partner_name||"ぽん");
  useEffect(()=>{save(STORAGE_KEYS.habits,habits);},[habits]);
  useEffect(()=>{save(STORAGE_KEYS.logs,logs);},[logs]);
  useEffect(()=>{save(STORAGE_KEYS.status,userStatus);},[userStatus]);
  useEffect(()=>{save(STORAGE_KEYS.settings,settings);},[settings]);
  useEffect(()=>{save(STORAGE_KEYS.trigger,triggerHabit);},[triggerHabit]);
  useEffect(()=>{save(STORAGE_KEYS.trigger_logs,triggerLogs);},[triggerLogs]);
  useEffect(()=>{save(STORAGE_KEYS.graduations,graduations);},[graduations]);
  useEffect(()=>{save(STORAGE_KEYS.recovery_events,recoveryEvents);},[recoveryEvents]);

  // 旧XP保存データ：当日の初回ボーナスを補い、旧全クリログを新XPへ正規化する。
  // 過去日付の確定済みXPは変更しない。
  useEffect(()=>{
    const restored=reconcileBonuses(logs,habits,dateKey);
    const total=calculateXp(restored);
    if(JSON.stringify(restored)!==JSON.stringify(logs))setLogs(restored);
    if(total!==userStatus.total_xp||calcLevel(total).level!==userStatus.level){
      setPrevXp(total);
      prevLevelRef.current=calcLevel(total).level;
      setUserStatus(old=>({...old,total_xp:total,level:calcLevel(total).level}));
    }
  },[dateKey]); // 当日の切替時と初回マウントのみ

  useEffect(()=>{
    if(fromDateKey(dateKey).getDay()!==0)return;
    const reviewKey="pon_weekly_reviewed";
    try {if(localStorage.getItem(reviewKey)===dateKey)return;} catch{}
    const t=setTimeout(()=>setShowWeeklyReview(true),800);
    return()=>clearTimeout(t);
  },[dateKey]);
  useEffect(()=>{
    const lastOpened=userStatus.last_opened_at;
    if(lastOpened&&lastOpened!==dateKey){
      const diff=Math.round((fromDateKey(dateKey)-fromDateKey(lastOpened))/86400000);
      if(diff>=3)setReturningDays(diff);
    }
    setUserStatus(s=>s.last_opened_at===dateKey?s:{...s,last_opened_at:dateKey});
  },[]);

  useEffect(()=>{
    const current=calcLevel(userStatus.total_xp).level;
    if(current>prevLevelRef.current){setLevelUpInfo({level:current});prevLevelRef.current=current;}
    else if(current<prevLevelRef.current){prevLevelRef.current=current;setLevelUpInfo(null);}
  },[userStatus.total_xp]);

  const applyLogs=useCallback((nextLogs)=>{
    const newTotal=calculateXp(nextLogs);
    setPrevXp(userStatus.total_xp);
    setLogs(nextLogs);
    setUserStatus(old=>({...old,total_xp:newTotal,level:calcLevel(newTotal).level}));
  },[userStatus.total_xp]);
  const eligibleToday=habits.filter(h=>isHabitEligibleOnDate(h,dateKey));

  const handleToggle=useCallback((habitId)=>{
    const habit=habits.find(h=>h.id===habitId);
    if(!habit||!habit.is_active||habit.graduated_at||!isHabitScheduledOnDate(habit,dateKey))return;
    const existing=logs.find(l=>l.habit_id===habitId&&l.executed_date===dateKey&&!l.is_bonus);
    const wasDone=!!existing&&!existing.is_reverted;
    let next;
    if(wasDone){
      next=logs.map(l=>l.id===existing.id?{...l,is_reverted:true}:l);
      // 取り消しでは復帰マークを無効化し、再完了時に同じレコードを再利用する。
      setRecoveryEvents(es=>es.map(e=>e.habit_id===habitId&&e.log_id===existing.id?{...e,is_reverted:true}:e));
    }else{
      if(!habits.some(h=>isHabitEligibleOnDate(h,dateKey)&&hasHabitDone(logs,h.id,dateKey)))setFirstNotice(true);
      const base=calcBaseXp(habitId,logs);
      const streak=isStreak(habit,logs,dateKey);
      const continuous=streak?(habit.frequency==="daily"?calcStreakBonus(calcStreakDays(habit,logs,dateKey)+1):1):0;
      const reward=base+continuous;
      const entry={id:existing?.id||`${Date.now()}-${habitId}`,habit_id:habitId,executed_date:dateKey,
        completed_at:new Date().toISOString(),xp_gained:reward,is_bonus:false,is_reverted:false,streak_active:streak};
      next=existing?logs.map(l=>l.id===existing.id?{...l,...entry}:l):[...logs,entry];
      // 復帰：連続条件を失った後の通常達成。同一の中断では1回のみ付与。
      const hasHistory=logs.some(l=>l.habit_id===habitId&&!l.is_bonus&&!l.is_reverted&&l.executed_date<dateKey);
      const priorEvents=recoveryEvents.filter(e=>e.habit_id===habitId&&e.executed_date<dateKey)
        .sort((a,b)=>b.executed_date.localeCompare(a.executed_date));
      const prior=priorEvents[0];
      let gapAfterPrior=false;
      if(prior){
        for(let day=addDateDays(prior.executed_date,1);day<dateKey;day=addDateDays(day,1)){
          if(isHabitScheduledOnDate(habit,day)&&!hasHabitDone(logs,habitId,day)){
            gapAfterPrior=true;break;
          }
        }
      }
      const sameEvent=recoveryEvents.find(e=>e.habit_id===habitId&&e.executed_date===dateKey);
      if(hasHistory&&!streak&&(sameEvent||!prior||gapAfterPrior)){
        if(sameEvent){
          setRecoveryEvents(es=>es.map(e=>e.id===sameEvent.id?{...e,is_reverted:false,log_id:entry.id}:e));
        }else{
          setRecoveryEvents(es=>[...es,{id:`recovery-${habitId}-${dateKey}`,episode_id:`${habitId}:${dateKey}`,
            habit_id:habitId,executed_date:dateKey,log_id:entry.id,is_reverted:false}]);
        }
        setReturnNotice({habitName:habit.name});
      }
    }
    next=reconcileBonuses(next,habits,dateKey,{allowAllNew:!wasDone});
    applyLogs(next);
  },[habits,logs,dateKey,applyLogs,recoveryEvents]);
  const [returnNotice,setReturnNotice]=useState(null);

  const handleAdd=useCallback(data=>{
    if(habits.filter(h=>h.is_active&&!h.deleted).length>=5)return;
    const now=new Date().toISOString();
    const nextHabits=[...habits,{id:`habit-${Date.now()}`,...data,is_active:true,deleted:false,created_at:now,updated_at:now,graduated_at:null,graduated_on:null}];
    setHabits(nextHabits);
    applyLogs(reconcileBonuses(logs,nextHabits,dateKey));
  },[habits,logs,dateKey,applyLogs]);
  const handleEdit=useCallback((id,data)=>{
    const nextHabits=habits.map(h=>h.id===id?{...h,...data,updated_at:new Date().toISOString()}:h);
    setHabits(nextHabits);
    applyLogs(reconcileBonuses(logs,nextHabits,dateKey));
  },[habits,logs,dateKey,applyLogs]);
  const handleDelete=useCallback(id=>{
    const nextHabits=habits.map(h=>h.id===id?{...h,is_active:false,graduated_at:null,graduated_on:null,deleted:!logs.some(l=>l.habit_id===id&&!l.is_bonus&&!l.is_reverted&&l.executed_date<dateKey),updated_at:new Date().toISOString()}:h);
    const reverted=logs.map(l=>l.habit_id===id&&l.executed_date===dateKey&&!l.is_bonus?{...l,is_reverted:true}:l);
    setHabits(nextHabits);
    setGraduations(g=>g.filter(x=>x.habit_id!==id));
    applyLogs(reconcileBonuses(reverted,nextHabits,dateKey));
  },[habits,logs,dateKey,applyLogs]);
  const handleToggleActive=useCallback(id=>{
    const habit=habits.find(h=>h.id===id);if(!habit||habit.graduated_at)return;
    if(!habit.is_active&&habits.filter(h=>h.is_active&&!h.deleted).length>=5)return;
    const nextHabits=habits.map(h=>h.id===id?{...h,is_active:!h.is_active,updated_at:new Date().toISOString()}:h);
    const updated=habit.is_active?logs.map(l=>l.habit_id===id&&l.executed_date===dateKey&&!l.is_bonus?{...l,is_reverted:true}:l):logs;
    setHabits(nextHabits);
    applyLogs(reconcileBonuses(updated,nextHabits,dateKey));
  },[habits,logs,dateKey,applyLogs]);

  const handleGraduate=useCallback(id=>{
    const habit=habits.find(h=>h.id===id);
    if(!habit||!habit.is_active||!isHabitScheduledOnDate(habit,dateKey)||!hasHabitDone(logs,id,dateKey))return;
    const graduatedAt=new Date().toISOString();
    const completed=logs.filter(l=>l.habit_id===id&&!l.is_bonus&&!l.is_reverted).length;
    const rank=completed>=1000?"platinum":completed>=300?"gold":completed>=100?"silver":"bronze";
    setHabits(prev=>prev.map(h=>h.id===id?{...h,is_active:false,graduated_at:graduatedAt,graduated_on:dateKey,updated_at:graduatedAt}:h));
    setGraduations(prev=>[...prev.filter(g=>g.habit_id!==id),{habit_id:id,graduated_at:graduatedAt,completion_count:completed,rank}]);
    // 習慣は卒業当日も判定対象。ここでログやXPを変更しない。
  },[habits,logs,dateKey]);
  const handleReactivate=useCallback(id=>{
    if(habits.filter(h=>h.is_active&&!h.deleted).length>=5)return;
    setHabits(prev=>prev.map(h=>h.id===id?{...h,is_active:true,graduated_at:null,graduated_on:null,updated_at:new Date().toISOString()}:h));
    setGraduations(prev=>prev.filter(g=>g.habit_id!==id));
  },[habits]);

  const handleResetTodayLogs=useCallback(newHour=>{
    const resetDates=new Set([getLogicalDate(offset),getLogicalDate(newHour)]);
    const reverted=logs.map(l=>resetDates.has(l.executed_date)?{...l,is_reverted:true}:l);
    applyLogs(reverted);
    setSettings(prev=>({...prev,day_start_hour:newHour}));
  },[logs,offset,applyLogs]);
  const handleCloseWeeklyReview=useCallback(()=>{
    setShowWeeklyReview(false);
    try{localStorage.setItem("pon_weekly_reviewed",dateKey);}catch{}
  },[dateKey]);
  const handleTriggerToggle=useCallback(()=>{
    const existing=triggerLogs.find(l=>l.executed_date===dateKey);
    if(existing){
      setTriggerLogs(prev=>prev.map(l=>l.id===existing.id?{...l,is_reverted:!l.is_reverted,completed_at:new Date().toISOString()}:l));
    }else setTriggerLogs(prev=>[...prev,{id:`trig-${Date.now()}`,executed_date:dateKey,completed_at:new Date().toISOString(),is_reverted:false}]);
  },[triggerLogs,dateKey]);
  const isZoomed = screenViewport.scale > 1.01;
  const zoomWidth = Math.min(screenViewport.width, 480);
  const shellStyle = {
    width: "100%", maxWidth: 480, margin:"0 auto",
    height: "100dvh", minHeight:0, boxSizing:"border-box",
    paddingTop:"env(safe-area-inset-top, 0px)", display:"flex",
    flexDirection:"column",background:activeTheme.bg,overflow:"hidden",
    overflowX:"clip",transition:"background .3s ease",
    ...(isZoomed ? {
      position:"fixed", top:screenViewport.top,
      left:screenViewport.left+Math.max(0,(screenViewport.width-zoomWidth)/2),
      width:zoomWidth, height:screenViewport.height, margin:0
    } : {})
  };
  const visibleHabits=habits.filter(h=>!h.deleted);
  const historyHabits=habits.filter(h=>!h.deleted||logs.some(l=>l.habit_id===h.id&&!l.is_bonus&&!l.is_reverted));

  return (<>
    <GlobalStyles theme={activeTheme}/>
    <div className="pon-root" style={shellStyle}>
      <div style={{flex:1,minHeight:0,overflow:"hidden",position:"relative",width:"100%"}}>
        {tab==="home"&&<HomeScreen habits={visibleHabits} logs={logs} userStatus={userStatus} onToggle={handleToggle}
          prevXp={prevXp} onGoToHabits={()=>setTab("habits")} offset={offset} levelUpInfo={levelUpInfo}
          onLevelUpDone={()=>setLevelUpInfo(null)} partnerName={partnerName} triggerHabit={triggerHabit}
          triggerLogs={triggerLogs} onTriggerToggle={handleTriggerToggle}/>}
        {tab==="habits"&&<HabitsScreen habits={visibleHabits} logs={logs} offset={offset}
          onAdd={handleAdd} onEdit={handleEdit} onDelete={handleDelete} onToggleActive={handleToggleActive}
          onGraduate={handleGraduate} onReactivate={handleReactivate}/>}
        {tab==="history"&&<HistoryScreen habits={historyHabits} logs={logs} offset={offset} triggerHabit={triggerHabit}
          triggerLogs={triggerLogs} graduations={graduations} recoveryEvents={recoveryEvents} onReactivate={handleReactivate}/>}
        {tab==="settings"&&<SettingsScreen settings={settings} onSave={setSettings} logs={logs}
          onResetTodayLogs={handleResetTodayLogs} partnerInput={partnerInput} onPartnerInputChange={setPartnerInput}
          onPreviewTheme={setPreviewThemeId} triggerHabit={triggerHabit} onSaveTrigger={setTriggerHabit}/>}
      </div>
      <NavBar tab={tab} onTab={next=>{setTab(next);if(next!=="settings")setPreviewThemeId(null);}}/>
    </div>
    {showWeeklyReview&&<WeeklyReviewOverlay logs={logs} habits={visibleHabits} offset={offset}
      triggerLogs={triggerLogs} triggerHabit={triggerHabit} totalXp={userStatus.total_xp}
      level={calcLevel(userStatus.total_xp).level} partnerName={partnerName} onClose={handleCloseWeeklyReview}/>}
    {returningDays!==null&&!showWeeklyReview&&<ReturningUserOverlay daysSince={returningDays}
      partnerName={partnerName} onKeep={()=>setReturningDays(null)}/>}
    {firstNotice&&<div role="status" style={{position:"fixed",zIndex:250,top:80,left:"50%",transform:"translateX(-50%)",background:activeTheme.card,border:`1px solid ${activeTheme.accent}55`,borderRadius:14,padding:"10px 18px",color:activeTheme.accent,fontSize:13,whiteSpace:"nowrap"}}>✦ 今日の第一歩 +15 XP</div>}
    {returnNotice&&<div role="status" style={{position:"fixed",zIndex:300,bottom:86,left:"50%",transform:"translateX(-50%)",maxWidth:420,width:"90%",background:activeTheme.card,border:`1px solid ${activeTheme.accent}55`,borderRadius:14,padding:18,textAlign:"center",boxShadow:"0 8px 30px rgba(0,0,0,.25)"}}>
      <div style={{color:activeTheme.accent,fontSize:15,marginBottom:7}}>◈ おかえり！ 復帰マーク獲得</div>
      <div style={{color:activeTheme.text,fontSize:12,marginBottom:12}}>「{returnNotice.habitName}」をまた続けられたね</div>
      <button onClick={()=>setReturnNotice(null)} style={{color:activeTheme.accent,padding:8}}>閉じる</button>
    </div>}
  </>);
}
