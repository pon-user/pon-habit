import { useState, useEffect, useCallback, useRef } from "react";

// ─── ユーティリティ ───────────────────────────────────────────────
// offsetHour: 1日の切り替わり時刻（0〜6）。この時刻前は前日扱い
const getLogicalDate = (offsetHour = 0) => {
  const now = new Date();
  // 切り替わり時刻前なら前日にずらす
  const shifted = new Date(now.getTime() - offsetHour * 60 * 60 * 1000);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}-${String(shifted.getDate()).padStart(2, "0")}`;
};
const getLogicalDow = (offsetHour = 0) => {
  const now = new Date();
  const shifted = new Date(now.getTime() - offsetHour * 60 * 60 * 1000);
  return shifted.getDay();
};
// 後方互換（offsetなし）
const today = () => getLogicalDate(0);
const todayDow = () => getLogicalDow(0);
const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

// Lv15までは急カーブ(^1.2)、Lv16以降は緩カーブ(^0.8)
function xpForLevel(level) {
  return level <= 15
    ? Math.floor(10 * Math.pow(level, 1.2))
    : Math.floor(10 * Math.pow(level, 0.8));
}

function calcLevel(xp) {
  let level = 1;
  let required = 0;
  while (true) {
    const next = xpForLevel(level);
    if (xp < required + next) {
      return { level, currentXp: xp - required, nextLevelXp: next };
    }
    required += next;
    level++;
  }
}

// 層1: 習慣ごとの累計達成回数に基づく基本XP
function calcBaseXp(habitId, allLogs) {
  const count = allLogs.filter(l => l.habit_id === habitId && !l.is_reverted && !l.is_bonus).length;
  if (count >= 100) return 4;
  if (count >= 30)  return 3;
  if (count >= 10)  return 2;
  return 1;
}

// 層2: 連続達成日数に基づくボーナスXP（段階制）
// streakDays: 連続達成日数（日次のみ正確。週次・週N回はisStreakのtrue/falseで代替）
function calcStreakBonus(streakDays) {
  if (streakDays >= 30) return 4;
  if (streakDays >= 14) return 3;
  if (streakDays >= 7)  return 2;
  if (streakDays >= 2)  return 1;
  return 0;
}

// 連続日数を logs から算出（daily のみ正確カウント。weekly/weekly_n は0か1）
function calcStreakDays(habit, allLogs, todayStr) {
  if (habit.frequency !== "daily") {
    // weekly/weekly_n は isStreak(bool) を呼び出し元で判断する
    // ここでは呼ばれない想定だが fallback として 0 を返す
    return 0;
  }
  const dates = new Set(
    allLogs.filter(l => l.habit_id === habit.id && !l.is_reverted && !l.is_bonus)
           .map(l => l.executed_date)
  );
  let streak = 0;
  let cur = new Date(todayStr + "T12:00:00");
  // 今日の1日前から遡る（今日はまだ完了していないタイミングで呼ばれるため）
  cur.setDate(cur.getDate() - 1);
  while (true) {
    const s = cur.toISOString().slice(0, 10);
    if (dates.has(s)) { streak++; cur.setDate(cur.getDate() - 1); }
    else break;
  }
  return streak;
}

// ─── ストレージ ───────────────────────────────────────────────────
const STORAGE_KEYS = { habits: "pon_habits", logs: "pon_logs", status: "pon_status", settings: "pon_settings", trigger: "pon_trigger", trigger_logs: "pon_trigger_logs" };

// 週N回習慣が今日表示されるか判定
// days_of_week: 実施する曜日の配列（例 [1,3,5]）
const isWeeklyNToday = (habit, dow) => {
  if (habit.frequency !== "weekly_n") return false;
  return Array.isArray(habit.days_of_week) && habit.days_of_week.includes(dow);
};

// 習慣が今日表示対象かどうか（頻度・曜日・トリガー除外を一括判定）
const isHabitActiveToday = (habit, dow) =>
  habit.is_active && !habit.deleted && (
    habit.frequency === "daily" ||
    (habit.frequency === "weekly" && habit.day_of_week === dow) ||
    isWeeklyNToday(habit, dow)
  );

// 週N回の連続判定: 前週に同じ習慣が days_of_week 数以上達成されていれば連続
const isWeeklyNStreak = (habitId, daysOfWeek, logs, todayStr, offset) => {
  const n = daysOfWeek.length;
  const todayDate = new Date(todayStr + "T12:00:00");
  // 前週の同じ曜日範囲（7日前まで）を確認
  const prevWeekDates = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(todayDate.getTime() - i * 86400000);
    prevWeekDates.push(d.toISOString().slice(0, 10));
  }
  const prevCount = logs.filter(l =>
    l.habit_id === habitId &&
    prevWeekDates.includes(l.executed_date) &&
    !l.is_reverted && !l.is_bonus
  ).length;
  return prevCount >= n;
};

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ─── パートナーコメント ────────────────────────────────────────────
// name: パートナー名（デフォルト「ぽん」）
function buildComments(name) {
  return {
    idle: [
      "今日の分、ひとつずついこう",
      "気が向いたら、ここから始めよう",
      `${name}はここで待ってるよ`,
      "小さくでいい。一歩だけでも",
    ],
    partial: [
      "いいね、ちゃんと積んでるよ",
      `続けてきたの、${name}は見てる`,
      "あとちょっと。焦らなくていい",
      "その調子でいこう",
    ],
    allDone: [
      "全部できた。今日は本当にえらい",
      "パーフェクト。気持ちよかったでしょ",
      `やりきった。${name}も嬉しいよ`,
      "全クリ。積み上がってるの見えてるよ",
    ],
    levelUp: [
      "レベルアップ！少しずつ本物になってきてるね",
      "ぐっと伸びた。この感じ、続けていこう",
      `成長してる。${name}も一緒に進んでるよ`,
    ],
    streak: [
      "続いてるね。それだけで十分すごい",
      "また来てくれた。うれしいよ",
      "連続記録、更新中だよ",
    ],
    empty: [
      "まずは1つ、習慣を追加してみよう",
      "ここから始めよう。小さくていい",
    ],
    noTask: [
      "今日は休みの日。ゆっくりしよう",
      "今日の予定はなし。ゆったりね",
    ],
  };
}
function getPonComment(state, partnerName = "ぽん") {
  const comments = buildComments(partnerName);
  const pool = comments[state] || comments.idle;
  return pool[Math.floor(Math.random() * pool.length)];
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
    html, body, #root { height: 100%; background: ${T.bg}; }
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
      font-size: 14px;
      width: 100%;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus, select:focus { border-color: ${T.accent}66; }
    select option { background: ${T.selectBg || T.card}; }
  `}</style>;
};

// ─── 久しぶり検知オーバーレイ ───────────────────────────────────
function ReturningUserOverlay({ daysSince, partnerName, onKeep, onReset }) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "0 24px",
      animation: "overlayIn 0.25s ease",
    }}>
      <div style={{
        width: "100%", maxWidth: 400,
        background: C.card,
        borderRadius: 20,
        border: `1px solid ${C.border}`,
        padding: "28px 24px",
        animation: "scaleIn 0.3s ease",
      }}>
        <div style={{ fontSize: 28, textAlign: "center", marginBottom: 16, opacity: 0.6 }}>●</div>
        <div style={{ fontSize: 15, color: C.text, textAlign: "center", lineHeight: 1.8, marginBottom: 8 }}>
          戻ってきたね。
        </div>
        <div style={{ fontSize: 13, color: C.textMuted, textAlign: "center", lineHeight: 1.8, marginBottom: 24 }}>
          {daysSince}日ぶりだよ。<br />
          {partnerName}はずっとここにいたよ。<br />
          <span style={{ fontSize: 12, color: C.textDim }}>
            この間の記録、どうする？
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={onKeep}
            style={{ width: "100%", padding: "13px", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", color: C.textMuted, fontSize: 14 }}
          >そのまま残す（記録を維持）</button>
          <button
            onClick={onReset}
            style={{
              width: "100%", padding: "13px",
              borderRadius: 12,
              border: `1px solid ${C.accent}55`,
              background: C.accentDim,
              color: C.accent, fontSize: 14, fontWeight: 500,
            }}
          >ここからまた始める</button>
        </div>
        <div style={{ fontSize: 11, color: C.textDim, textAlign: "center", marginTop: 16, lineHeight: 1.6 }}>
          ※「ここからまた始める」を選んでも XP は変わりません。<br />連続カウントだけリセットされます。
        </div>
      </div>
    </div>
  );
}

// ─── 週次ふりかえりオーバーレイ ─────────────────────────────────
function WeeklyReviewOverlay({ logs, habits, triggerLogs, triggerHabit, totalXp, level, partnerName, onClose }) {
  // 先週の日曜〜土曜を算出
  const todayDate = new Date();
  const dayOfWeek = todayDate.getDay(); // 0=日
  // 今日が日曜なので「先週日曜〜昨日土曜」を対象にする
  const lastSun = new Date(todayDate); lastSun.setDate(todayDate.getDate() - 7);
  const lastSat = new Date(todayDate); lastSat.setDate(todayDate.getDate() - 1);
  const weekStart = lastSun.toISOString().slice(0, 10);
  const weekEnd   = lastSat.toISOString().slice(0, 10);

  // 先週の通常完了ログ
  const weekLogs = logs.filter(l =>
    !l.is_reverted && !l.is_bonus &&
    l.executed_date >= weekStart && l.executed_date <= weekEnd
  );
  const weekXp = weekLogs.reduce((s, l) => s + (l.xp_gained || 0), 0)
    + logs.filter(l => l.is_bonus && !l.is_reverted && l.executed_date >= weekStart && l.executed_date <= weekEnd)
          .reduce((s, l) => s + (l.xp_gained || 0), 0);

  // 習慣別達成率
  const activeHabits = habits.filter(h => h.is_active && !h.deleted && !h.is_trigger);
  const habitStats = activeHabits.map(h => {
    const hLogs = weekLogs.filter(l => l.habit_id === h.id);
    // 対象曜日数を計算
    let expected = 0;
    for (let d = new Date(weekStart + "T12:00:00"); d <= new Date(weekEnd + "T12:00:00"); d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
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
  const rate = totalExpected > 0 ? Math.round((totalDone / totalExpected) * 100) : 0;

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
              "--dx": p.dx,
              "--dy": p.dy,
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
function TaskRow({ habit, log, onToggle }) {
  const done = log && !log.is_reverted;
  const [anim, setAnim] = useState(false);

  const handleToggle = () => {
    setAnim(true);
    setTimeout(() => setAnim(false), 300);
    onToggle(habit.id);
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
      padding: "14px 20px",
      borderBottom: `1px solid ${C.border}`,
      background: done ? C.accentDim.replace("0.1)", "0.05)").replace("0.12)", "0.04)") : "transparent",
      transition: "background 0.3s ease",
    }}>
      <button
        onClick={handleToggle}
        className={anim ? "check-pop" : ""}
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          border: `2px solid ${done ? C.accent : C.checkboxBorder}`,
          background: done ? C.accentDim : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          transition: "all 0.2s ease",
          boxShadow: done ? `0 0 10px ${C.accentGlow}` : "none",
        }}
      >
        {done && <Icon name="check" size={14} color={C.accent} />}
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
  const todayHabits = habits.filter(h => isHabitActiveToday(h, dow));
  const todayLogs = logs.filter(l => l.executed_date === todayStr);
  // 通常完了ログのみ（ボーナスログを除外して正確にカウント）
  const doneCount = todayLogs.filter(l => !l.is_reverted && !l.is_bonus).length;
  const total = todayHabits.length;
  // 全クリボーナスの状態
  const bonusActive = todayLogs.some(l => l.is_bonus && !l.is_reverted);
  const bonusXpAmount = todayLogs
    .filter(l => l.is_bonus && !l.is_reverted)
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
      setPonComment(getPonComment("levelUp", partnerName));
      prevLevelUpInfo.current = levelUpInfo;
    }
  }, [levelUpInfo]);

  useEffect(() => {
    if (!levelUpInfo) {
      setPonComment(getPonComment(state, partnerName));
    }
  }, [state, partnerName]);

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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
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
      <div style={{ flex: 1, overflowY: "auto" }}>
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
  background: variant === "danger" ? C.dangerDim : "transparent",
  color: variant === "danger" ? C.danger : C.textMuted,
  fontSize: 14,
  cursor: "pointer",
});

// ─── モーダル ─────────────────────────────────────────────────────
function Modal({ onClose, children, title }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-end",
        animation: "overlayIn 0.2s ease",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 480,
          margin: "0 auto",
          background: C.card,
          borderRadius: "20px 20px 0 0",
          border: `1px solid ${C.border}`,
          borderBottom: "none",
          padding: "24px 20px 36px",
          animation: "slideUp 0.3s ease",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 500, color: C.titleColor || C.text }}>{title}</h2>
          <button onClick={onClose} style={{ color: C.textMuted, padding: 4 }}>
            <Icon name="x" size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
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
        padding: "13px 20px",
        borderBottom: `1px solid ${C.border}`,
        background: done ? C.accentDim.replace("0.1)", "0.04)").replace("0.12)", "0.04)") : "transparent",
        transition: "background 0.3s ease",
      }}>
        <button
          onClick={handleToggle}
          className={anim ? "check-pop" : ""}
          style={{
            width: 26, height: 26, borderRadius: 8,
            border: `2px solid ${done ? C.accent : C.checkboxBorder}`,
            background: done ? C.accentDim : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0, transition: "all 0.2s ease",
            boxShadow: done ? `0 0 10px ${C.accentGlow}` : "none",
          }}
        >
          {done && <Icon name="check" size={14} color={C.accent} />}
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
        width: 36, height: 36, borderRadius: 10,
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
        <input value={name} onChange={e => setName(e.target.value)} placeholder="例：朝の散歩" maxLength={30} autoFocus />
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
        <Label>通知時刻</Label>
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
function HabitsScreen({ habits, onAdd, onEdit, onDelete, onToggleActive }) {
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const activeCount = habits.filter(h => h.is_active).length;
  const atMax = activeCount >= 5;

  const handleAdd = (data) => {
    onAdd(data);
    setShowForm(false);
  };
  const handleEdit = (data) => {
    onEdit(editTarget.id, data);
    setEditTarget(null);
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", paddingBottom: 24 }}>
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

      {habits.map(h => (
        <div key={h.id} className="fade-up" style={{
          margin: "10px 16px",
          background: C.card,
          borderRadius: 14,
          border: `1px solid ${h.is_active ? C.border : C.cardAlt}`,
          overflow: "hidden",
          opacity: h.is_active ? 1 : 0.5,
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
function HistoryScreen({ habits, logs, offset = 0, triggerHabit, triggerLogs }) {
  const [selected, setSelected] = useState(null);

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

  // 連続日数：offset考慮・当日完了状態をリアルタイム反映
  let streak = 0;
  const todayStrH = getLogicalDate(offset);
  if (habit?.frequency === "daily") {
    const dates = new Set(habitLogs.map(l => l.executed_date));
    let cur = new Date(todayStrH + "T12:00:00");
    while (true) {
      const s = cur.toISOString().slice(0, 10);
      if (dates.has(s)) { streak++; cur.setDate(cur.getDate() - 1); }
      else break;
    }
  } else if (habit?.frequency === "weekly_n") {
    // 週N回: 前週ごとにN回達成していれば連続
    const n = (habit.days_of_week || []).length;
    let weekStart = new Date(todayStrH + "T12:00:00");
    while (true) {
      const weekEnd = new Date(weekStart.getTime());
      const weekStartDate = new Date(weekStart.getTime() - 6 * 86400000);
      const ws = weekStartDate.toISOString().slice(0, 10);
      const we = weekStart.toISOString().slice(0, 10);
      const count = habitLogs.filter(l => l.executed_date >= ws && l.executed_date <= we).length;
      if (count >= n) { streak++; weekStart = new Date(weekStartDate.getTime() - 86400000); }
      else break;
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
    const d = new Date(s);
    return `${d.getMonth() + 1}月${d.getDate()}日（${DOW_LABELS[d.getDay()]}）`;
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
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

      {/* 集計 */}
      {habit && (
        <div style={{
          display: "flex",
          gap: 10,
          padding: "14px 16px",
          borderBottom: `1px solid ${C.border}`,
        }}>
          {[
            { label: "連続", value: habit.frequency === "daily" ? `${streak}日` : "—" },
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
  const FORBIDDEN_RE = /[<>&"'`\\\/\x00-\x1f\x7f]/;
  const FORBIDDEN_DESC = '< > & " \' ` \\ /';

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
      display: "flex",
      borderTop: `1px solid ${C.border}`,
      background: C.card,
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

// ─── メインアプリ ─────────────────────────────────────────────────
export default function App() {
  const [habits, setHabits] = useState(() => load(STORAGE_KEYS.habits, []));
  const [logs, setLogs] = useState(() => load(STORAGE_KEYS.logs, []));
  const [userStatus, setUserStatus] = useState(() =>
    load(STORAGE_KEYS.status, { total_xp: 0, level: 1, last_opened_at: null })
  );
  const [settings, setSettings] = useState(() =>
    load(STORAGE_KEYS.settings, { day_start_hour: 0, theme: "dark", partner_name: "ぽん" })
  );
  // トリガー習慣（単独・XP/全クリ対象外・上限別管理）
  const [triggerHabit, setTriggerHabit] = useState(() =>
    load(STORAGE_KEYS.trigger, null)
  );
  const [triggerLogs, setTriggerLogs] = useState(() =>
    load(STORAGE_KEYS.trigger_logs, [])
  );
  const [tab, setTab] = useState("home");
  const [prevXp, setPrevXp] = useState(userStatus.total_xp);
  // レベルアップ演出：App側で管理し、画面遷移では再発火しない
  const [levelUpInfo, setLevelUpInfo] = useState(null); // { level } or null
  const prevLevelRef = useRef(calcLevel(userStatus.total_xp).level);
  // 週次ふりかえり（毎週日曜日に表示）
  const [showWeeklyReview, setShowWeeklyReview] = useState(false);
  // 久しぶり検知
  const [returningDays, setReturningDays] = useState(null); // null=通常, N=N日ぶり

  // ショートハンド
  const offset = settings.day_start_hour ?? 0;
  const currentTheme = getTheme(settings.theme ?? "dark");
  const partnerName = settings.partner_name || "ぽん";
  // プレビューテーマ（設定画面でセレクト変更時に一時適用。保存前はsettings.themeを変えない）
  const [previewThemeId, setPreviewThemeId] = useState(null);
  const activeTheme = previewThemeId ? getTheme(previewThemeId) : currentTheme;
  // グローバルCをアクティブテーマで上書き（コンポーネント間共有）
  C = activeTheme;

  // パートナー入力値はApp側で保持（タブ切り替えでSettingsScreenがアンマウントされてもリセットされない）
  const [partnerInput, setPartnerInput] = useState(settings.partner_name || "ぽん");

  // 永続化
  useEffect(() => { save(STORAGE_KEYS.habits, habits); }, [habits]);
  useEffect(() => { save(STORAGE_KEYS.logs, logs); }, [logs]);
  useEffect(() => { save(STORAGE_KEYS.status, userStatus); }, [userStatus]);
  useEffect(() => { save(STORAGE_KEYS.settings, settings); }, [settings]);
  useEffect(() => { save(STORAGE_KEYS.trigger, triggerHabit); }, [triggerHabit]);
  useEffect(() => { save(STORAGE_KEYS.trigger_logs, triggerLogs); }, [triggerLogs]);

  // 週次ふりかえり: 毎週日曜日に自動表示
  useEffect(() => {
    const todayStr = getLogicalDate(offset);
    const todayD = new Date(todayStr + "T12:00:00");
    if (todayD.getDay() !== 0) return; // 日曜日以外はスキップ
    const reviewKey = "pon_weekly_reviewed";
    const lastReviewed = localStorage.getItem(reviewKey);
    if (lastReviewed !== todayStr) {
      // 今日まだ表示していない → 少し遅延して表示
      const t = setTimeout(() => setShowWeeklyReview(true), 800);
      return () => clearTimeout(t);
    }
  }, [offset]);

  // 久しぶり検知: 3日以上ログインがなければ検知
  useEffect(() => {
    const todayStr = getLogicalDate(offset);
    const lastOpened = userStatus.last_opened_at;
    if (!lastOpened) {
      // 初回 → last_opened_at を更新して終了
      setUserStatus(s => ({ ...s, last_opened_at: todayStr }));
      return;
    }
    const lastDate = new Date(lastOpened + "T12:00:00");
    const todayDate = new Date(todayStr + "T12:00:00");
    const diffDays = Math.round((todayDate - lastDate) / 86400000);
    if (diffDays >= 3) {
      setReturningDays(diffDays);
    }
    // last_opened_at を今日で更新
    if (lastOpened !== todayStr) {
      setUserStatus(s => ({ ...s, last_opened_at: todayStr }));
    }
  }, []); // マウント時1回のみ

  // XP変化を監視してレベルアップを検知（App側で一元管理）
  useEffect(() => {
    const cur = calcLevel(userStatus.total_xp).level;
    if (cur > prevLevelRef.current) {
      setLevelUpInfo({ level: cur });
      prevLevelRef.current = cur;
    } else if (cur < prevLevelRef.current) {
      // レベルダウン（達成取り消し）→ 演出リセットして再発火を許可
      prevLevelRef.current = cur;
      setLevelUpInfo(null);
    }
  }, [userStatus.total_xp]);

  // 連続判定（offset考慮・weekly_n対応）
  const isStreak = useCallback((habit) => {
    const todayStr = getLogicalDate(offset);
    if (habit.frequency === "daily") {
      const yDate = new Date(todayStr + "T00:00:00");
      yDate.setDate(yDate.getDate() - 1);
      const ys = yDate.toISOString().slice(0, 10);
      return logs.some(l => l.habit_id === habit.id && l.executed_date === ys && !l.is_reverted);
    } else if (habit.frequency === "weekly_n") {
      return isWeeklyNStreak(habit.id, habit.days_of_week || [], logs, todayStr, offset);
    } else {
      const pDate = new Date(todayStr + "T00:00:00");
      pDate.setDate(pDate.getDate() - 7);
      const ps = pDate.toISOString().slice(0, 10);
      return logs.some(l => l.habit_id === habit.id && l.executed_date === ps && !l.is_reverted);
    }
  }, [logs, offset]);

  // 当日のlogsからtotal_xpを再計算するヘルパー（offset考慮）
  const recalcXpFromLogs = useCallback((nextLogs) => {
    const todayStr = getLogicalDate(offset);
    const todayXp = nextLogs
      .filter(l => l.executed_date === todayStr && !l.is_reverted)
      .reduce((sum, l) => sum + (l.xp_gained || 0), 0);
    const pastXp = nextLogs
      .filter(l => l.executed_date < todayStr && !l.is_reverted && !l.is_bonus)
      .reduce((sum, l) => sum + (l.xp_gained || 0), 0);
    const pastBonus = nextLogs
      .filter(l => l.executed_date < todayStr && !l.is_reverted && l.is_bonus)
      .reduce((sum, l) => sum + (l.xp_gained || 0), 0);
    return pastXp + pastBonus + todayXp;
  }, [offset]);

  // タスクトグル（offset考慮）
  const handleToggle = useCallback((habitId) => {
    const todayStr = getLogicalDate(offset);
    const dow = getLogicalDow(offset);
    const habit = habits.find(h => h.id === habitId);
    if (!habit) return;

    // 当日のこの習慣の通常ログ
    const existing = logs.find(l => l.habit_id === habitId && l.executed_date === todayStr && !l.is_bonus);
    // 当日の全クリボーナスログ
    const todayBonusLog = logs.find(l => l.executed_date === todayStr && l.is_bonus);

    const isDone = existing && !existing.is_reverted;

    if (isDone) {
      // ── 取り消し ──
      // 1. この習慣ログをreverted
      // 2. 全クリボーナスも存在すれば同時にreverted（全クリ崩れるため）
      const nextLogs = logs.map(l => {
        if (l.id === existing.id) return { ...l, is_reverted: true };
        if (todayBonusLog && l.id === todayBonusLog.id) return { ...l, is_reverted: true };
        return l;
      });
      const newTotalXp = recalcXpFromLogs(nextLogs);
      setLogs(nextLogs);
      setPrevXp(userStatus.total_xp);
      setUserStatus(s => ({ ...s, total_xp: newTotalXp, level: calcLevel(newTotalXp).level }));

    } else {
      // ── 完了 ──
      // 層1: 累計達成回数ベースの基本XP（完了前の回数で算出）
      const baseXp = calcBaseXp(habit.id, logs);
      // 層2: 連続達成ボーナス（段階制）
      const streakActive = isStreak(habit);
      let streakBonus = 0;
      if (streakActive) {
        if (habit.frequency === "daily") {
          const days = calcStreakDays(habit, logs, todayStr);
          streakBonus = calcStreakBonus(days + 1); // +1は今日分
        } else {
          // weekly/weekly_n は段階なし（連続確認だけ）→ +1XP固定
          streakBonus = 1;
        }
      }
      const xp = baseXp + streakBonus;

      // 今日の対象タスク一覧（is_trigger フラグは使っていないため isHabitActiveToday で統一）
      const todayHabits = habits.filter(h => isHabitActiveToday(h, dow));
      // この習慣以外が全て完了済みか
      const otherDone = todayHabits
        .filter(h => h.id !== habitId)
        .every(h => logs.some(l => l.habit_id === h.id && l.executed_date === todayStr && !l.is_reverted && !l.is_bonus));
      // 今日まだボーナス未付与（revertedも含めて一度も付与されていないか、revertedのみか）
      const bonusAlreadyActive = logs.some(l => l.executed_date === todayStr && l.is_bonus && !l.is_reverted);

      let bonusXp = 0;
      if (otherDone && todayHabits.length > 0 && !bonusAlreadyActive) {
        bonusXp = Math.min(todayHabits.length, 5);
      }

      // ログを更新（既存revertedを復活 or 新規追加）
      // 取り消し→再登録の場合も completed_at を最新時刻で更新（修正①）
      let nextLogs;
      if (existing) {
        // revertedだった → 復活（completed_atを再登録時刻で上書き）
        nextLogs = logs.map(l => l.id === existing.id
          ? { ...l, is_reverted: false, xp_gained: xp, completed_at: new Date().toISOString() }
          : l
        );
      } else {
        nextLogs = [...logs, {
          id: `${Date.now()}-${habitId}`,
          habit_id: habitId,
          executed_date: todayStr,
          completed_at: new Date().toISOString(),
          xp_gained: xp,
          is_reverted: false,
          is_bonus: false,
        }];
      }

      // ボーナスログ：既存のrevertedボーナスがあれば復活、なければ新規
      if (bonusXp > 0) {
        if (todayBonusLog) {
          nextLogs = nextLogs.map(l =>
            l.id === todayBonusLog.id ? { ...l, is_reverted: false, xp_gained: bonusXp } : l
          );
        } else {
          nextLogs.push({
            id: `bonus-${Date.now()}`,
            habit_id: habitId,
            executed_date: todayStr,
            completed_at: new Date().toISOString(),
            xp_gained: bonusXp,
            is_reverted: false,
            is_bonus: true,
          });
        }
      }

      const newTotalXp = recalcXpFromLogs(nextLogs);
      setLogs(nextLogs);
      setPrevXp(userStatus.total_xp);
      setUserStatus(s => ({ ...s, total_xp: newTotalXp, level: calcLevel(newTotalXp).level }));
    }
  }, [habits, logs, userStatus.total_xp, isStreak, recalcXpFromLogs, offset]);

  // 習慣追加
  const handleAdd = useCallback((data) => {
    const activeCount = habits.filter(h => h.is_active).length;
    if (activeCount >= 5) return;
    const now = new Date().toISOString();
    const newHabit = {
      id: `habit-${Date.now()}`,
      ...data,
      is_active: true,
      created_at: now,
      updated_at: now,
    };
    setHabits(prev => [...prev, newHabit]);
  }, [habits]);

  // 習慣編集
  const handleEdit = useCallback((id, data) => {
    setHabits(prev => prev.map(h =>
      h.id === id ? { ...h, ...data, updated_at: new Date().toISOString() } : h
    ));
  }, []);

  // 習慣削除（論理削除）＋当日分XPの取り消し（offset考慮）
  const handleDelete = useCallback((id) => {
    const todayStr = getLogicalDate(offset);
    const nextLogs = logs.map(l =>
      l.habit_id === id && l.executed_date === todayStr && !l.is_reverted
        ? { ...l, is_reverted: true }
        : l
    );
    const bonusLog = nextLogs.find(l => l.executed_date === todayStr && l.is_bonus && !l.is_reverted);
    const finalLogs = bonusLog
      ? nextLogs.map(l => l.id === bonusLog.id ? { ...l, is_reverted: true } : l)
      : nextLogs;

    const newTotalXp = recalcXpFromLogs(finalLogs);
    setLogs(finalLogs);
    setPrevXp(userStatus.total_xp);
    setUserStatus(s => ({ ...s, total_xp: newTotalXp, level: calcLevel(newTotalXp).level }));

    const hasPastXp = finalLogs.some(
      l => l.habit_id === id && !l.is_bonus && !l.is_reverted && l.executed_date < todayStr
    );

    setHabits(prev => prev.map(h =>
      h.id === id
        ? { ...h, is_active: false, deleted: !hasPastXp, updated_at: new Date().toISOString() }
        : h
    ));
  }, [logs, userStatus.total_xp, recalcXpFromLogs, offset]);

  // 有効/無効切替（offset考慮）
  const handleToggleActive = useCallback((id) => {
    const habit = habits.find(h => h.id === id);
    if (!habit) return;

    if (habit.is_active) {
      const todayStr = getLogicalDate(offset);
      const nextLogs = logs.map(l =>
        l.habit_id === id && l.executed_date === todayStr && !l.is_reverted
          ? { ...l, is_reverted: true }
          : l
      );
      const bonusLog = nextLogs.find(l => l.executed_date === todayStr && l.is_bonus && !l.is_reverted);
      const finalLogs = bonusLog
        ? nextLogs.map(l => l.id === bonusLog.id ? { ...l, is_reverted: true } : l)
        : nextLogs;

      const newTotalXp = recalcXpFromLogs(finalLogs);
      setLogs(finalLogs);
      setPrevXp(userStatus.total_xp);
      setUserStatus(s => ({ ...s, total_xp: newTotalXp, level: calcLevel(newTotalXp).level }));
    } else {
      const activeCount = habits.filter(h => h.is_active).length;
      if (activeCount >= 5) return;
    }

    setHabits(prev => prev.map(h =>
      h.id === id ? { ...h, is_active: !h.is_active, updated_at: new Date().toISOString() } : h
    ));
  }, [habits, logs, userStatus.total_xp, recalcXpFromLogs, offset]);

  // 切り替わり時刻変更時：新旧両方のoffsetで当日ログをリセットしてXP再計算・設定保存
  const handleResetTodayLogs = useCallback((newHour) => {
    const oldTodayStr = getLogicalDate(offset);
    const newTodayStr = getLogicalDate(newHour);
    // 新旧どちらかの「今日」にあたるログをすべてrevertedに
    const datesToReset = new Set([oldTodayStr, newTodayStr]);
    const nextLogs = logs.map(l =>
      datesToReset.has(l.executed_date) && !l.is_reverted
        ? { ...l, is_reverted: true }
        : l
    );
    // XPを再計算（リセット後のlogsをベースに、新しいoffsetで）
    const newOffset = newHour;
    const newTodayForCalc = getLogicalDate(newOffset);
    const todayXp = nextLogs
      .filter(l => l.executed_date === newTodayForCalc && !l.is_reverted)
      .reduce((sum, l) => sum + (l.xp_gained || 0), 0);
    const pastXp = nextLogs
      .filter(l => l.executed_date < newTodayForCalc && !l.is_reverted && !l.is_bonus)
      .reduce((sum, l) => sum + (l.xp_gained || 0), 0);
    const pastBonus = nextLogs
      .filter(l => l.executed_date < newTodayForCalc && !l.is_reverted && l.is_bonus)
      .reduce((sum, l) => sum + (l.xp_gained || 0), 0);
    const newTotalXp = pastXp + pastBonus + todayXp;
    setLogs(nextLogs);
    setPrevXp(userStatus.total_xp);
    setUserStatus(s => ({ ...s, total_xp: newTotalXp, level: calcLevel(newTotalXp).level }));
    setSettings(prev => ({ ...prev, day_start_hour: newHour }));
  }, [logs, offset, userStatus.total_xp]);

  // 週次ふりかえりクローズ
  const handleCloseWeeklyReview = useCallback(() => {
    setShowWeeklyReview(false);
    const todayStr = getLogicalDate(offset);
    try { localStorage.setItem("pon_weekly_reviewed", todayStr); } catch {}
  }, [offset]);

  // 久しぶり検知: 「そのまま残す」
  const handleReturningKeep = useCallback(() => {
    setReturningDays(null);
  }, []);

  // 久しぶり検知: 「ここからまた始める」= 連続カウントのみリセット
  // XPは変えない。連続ログ（昨日以前）をrevertedにするのではなく
  // 「昨日のログがない」状態を作るためにダミー日付を設定する手法は副作用が大きいため、
  // ここでは「表示上のリセット」として last_opened_at を3日前に偽装せず、
  // 単にモーダルを閉じるだけとする（連続判定は自然にリセットされているため）
  const handleReturningReset = useCallback(() => {
    setReturningDays(null);
    // 連続は既に途切れているので追加操作不要。気持ちだけリセット扱い。
  }, []);

  // トリガー習慣トグル
  const handleTriggerToggle = useCallback(() => {
    const todayStr = getLogicalDate(offset);
    const existing = triggerLogs.find(l => l.executed_date === todayStr && !l.is_reverted);
    if (existing) {
      setTriggerLogs(prev => prev.map(l => l.id === existing.id ? { ...l, is_reverted: true } : l));
    } else {
      setTriggerLogs(prev => [...prev, {
        id: `trig-${Date.now()}`,
        executed_date: todayStr,
        completed_at: new Date().toISOString(),
        is_reverted: false,
      }]);
    }
  }, [triggerLogs, offset]);

  const visibleHabits = habits.filter(h => !h.deleted);
  // 履歴画面用：削除済みでも過去XP実績がある習慣は表示する（offset考慮）
  const historyHabits = habits.filter(h =>
    !h.deleted || logs.some(l => l.habit_id === h.id && !l.is_bonus && !l.is_reverted && l.executed_date < getLogicalDate(offset))
  );

  return (
    <>
      <GlobalStyles theme={activeTheme} />
      <div style={{
        maxWidth: 480,
        margin: "0 auto",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: activeTheme.bg,
        overflow: "hidden",
        transition: "background 0.3s ease",
      }}>
        {/* コンテンツ */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {tab === "home" && (
            <HomeScreen
              habits={visibleHabits}
              logs={logs}
              userStatus={userStatus}
              onToggle={handleToggle}
              prevXp={prevXp}
              onGoToHabits={() => setTab("habits")}
              offset={offset}
              levelUpInfo={levelUpInfo}
              onLevelUpDone={() => setLevelUpInfo(null)}
              partnerName={partnerName}
              triggerHabit={triggerHabit}
              triggerLogs={triggerLogs}
              onTriggerToggle={handleTriggerToggle}
            />
          )}
          {tab === "habits" && (
            <HabitsScreen
              habits={visibleHabits}
              onAdd={handleAdd}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onToggleActive={handleToggleActive}
            />
          )}
          {tab === "history" && (
            <HistoryScreen habits={historyHabits} logs={logs} offset={offset} triggerHabit={triggerHabit} triggerLogs={triggerLogs} />
          )}
          {tab === "settings" && (
            <SettingsScreen
              settings={settings}
              onSave={setSettings}
              logs={logs}
              onResetTodayLogs={handleResetTodayLogs}
              partnerInput={partnerInput}
              onPartnerInputChange={setPartnerInput}
              onPreviewTheme={id => setPreviewThemeId(id)}
              triggerHabit={triggerHabit}
              onSaveTrigger={setTriggerHabit}
            />
          )}
        </div>
        {/* ナビ */}
        <NavBar tab={tab} onTab={(t) => { setTab(t); if (t !== "settings") setPreviewThemeId(null); }} />
      </div>

      {/* 週次ふりかえり */}
      {showWeeklyReview && (
        <WeeklyReviewOverlay
          logs={logs}
          habits={visibleHabits}
          triggerLogs={triggerLogs}
          triggerHabit={triggerHabit}
          totalXp={userStatus.total_xp}
          level={calcLevel(userStatus.total_xp).level}
          partnerName={partnerName}
          onClose={handleCloseWeeklyReview}
        />
      )}

      {/* 久しぶり検知（週次ふりかえりより優先） */}
      {returningDays !== null && !showWeeklyReview && (
        <ReturningUserOverlay
          daysSince={returningDays}
          partnerName={partnerName}
          onKeep={handleReturningKeep}
          onReset={handleReturningReset}
        />
      )}
    </>
  );
}
