const STORAGE_KEY = "weather_health_profiles_v1";
const LOG_STORAGE_KEY = "weather_health_symptom_logs_v1";

const ALLERGEN_DEFS = [
  { key: "cedar", label: "スギ（春・季節補正）" },
  { key: "cypress", label: "ヒノキ（春〜初夏補正）" },
  { key: "ragweed", label: "ブタクサ（秋・API）" },
  { key: "grass", label: "イネ科（春夏・API）" },
  { key: "pollen_misc", label: "ヨモギ/ハンノキ/カバノキ" },
  { key: "pm25_dust", label: "黄砂・PM2.5" }
];

const DEFAULT_USERS = [
  {
    id: "user_1",
    name: "ユーザー1（標準）",
    lat: 35.728,
    lon: 139.477,
    locationName: "東京都小平市",
    pressureThreshold: -5.0,
    tempThreshold: 7.0,
    allergens: {
      cedar: true,
      cypress: true,
      ragweed: true,
      grass: false,
      pollen_misc: false,
      pm25_dust: true
    }
  },
  {
    id: "user_2",
    name: "ユーザー2（秋花粉重視）",
    lat: 35.728,
    lon: 139.477,
    locationName: "東京都小平市",
    pressureThreshold: -4.0,
    tempThreshold: 6.0,
    allergens: {
      cedar: false,
      cypress: false,
      ragweed: true,
      grass: true,
      pollen_misc: true,
      pm25_dust: false
    }
  }
];

// 指スライド・ピンチ用プラグインを登録（読み込めなかった場合もグラフ自体は表示）
if (window.ChartZoom && !Chart.registry.plugins.get("zoom")) Chart.register(window.ChartZoom);

let users = loadUsers();
let currentUserId = users[0].id;
let weatherChart = null;
let pollenChart = null;
let latestSnapshot = null;

function loadUsers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.error("Failed to load users:", e);
  }
  return structuredClone(DEFAULT_USERS);
}

function saveUsers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(users));
}

function getCurrentUser() {
  return users.find((u) => u.id === currentUserId) || users[0];
}

function loadLogs() {
  try {
    return JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveLog(conditionText) {
  const user = getCurrentUser();
  const logs = loadLogs();
  const now = new Date();
  const entry = {
    time: now.toLocaleString("ja-JP"),
    userName: user.name,
    condition: conditionText,
    pressure: latestSnapshot?.currentPressure ?? "-",
    temp: latestSnapshot?.currentTemp ?? "-",
    score: latestSnapshot?.riskScore ?? "-"
  };
  logs.unshift(entry);
  localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logs.slice(0, 50)));
  renderLogs();
}

function renderLogs() {
  const list = document.getElementById("symptomLogList");
  const logs = loadLogs();
  if (logs.length === 0) {
    list.innerHTML = "<li>まだ体調記録はありません。</li>";
    return;
  }
  list.innerHTML = logs
    .map(
      (item) =>
        `<li><strong>${item.time}</strong> [${item.userName}] → <b>${item.condition}</b> (気圧: ${item.pressure}hPa / 気温: ${item.temp}℃ / スコア: ${item.score})</li>`
    )
    .join("");
}

function renderUserSelector() {
  const select = document.getElementById("userSelect");
  select.innerHTML = users
    .map((u) => `<option value="${u.id}" ${u.id === currentUserId ? "selected" : ""}>${u.name}</option>`)
    .join("");
}

function renderUserSettingsForm() {
  const user = getCurrentUser();
  const grid = document.getElementById("allergenGrid");
  grid.innerHTML = ALLERGEN_DEFS.map((def) => {
    const checked = Boolean(user.allergens[def.key]);
    return `
      <label class="checkbox-label">
        <input type="checkbox" data-allergen="${def.key}" ${checked ? "checked" : ""} />
        <span>${def.label}</span>
      </label>
    `;
  }).join("");

  document.getElementById("pressureThreshold").value = user.pressureThreshold;
  document.getElementById("tempThreshold").value = user.tempThreshold;

  const locSelect = document.getElementById("locationSelect");
  const locValue = `${user.lat},${user.lon},${user.locationName}`;
  const exists = Array.from(locSelect.options).some((opt) => opt.value === locValue);
  if (exists) {
    locSelect.value = locValue;
  }
}

// スギ・ヒノキは日本国内の季節性・気温・風速・乾燥度から飛散指数(0-100)を補完算出
function calcJapaneseSpringPollenIndex(dateObj, tempC, windKmh, humidityPct, species) {
  const month = dateObj.getMonth() + 1; // 1-12
  let seasonFactor = 0;

  if (species === "cedar") {
    if (month === 2) seasonFactor = 35;
    else if (month === 3) seasonFactor = 80;
    else if (month === 4) seasonFactor = 55;
    else if (month === 5) seasonFactor = 15;
  } else if (species === "cypress") {
    if (month === 3) seasonFactor = 25;
    else if (month === 4) seasonFactor = 85;
    else if (month === 5) seasonFactor = 50;
  }

  if (seasonFactor === 0) return 0;

  const tempBoost = Math.max(0, Math.min(20, (tempC - 10) * 1.5));
  const windBoost = Math.max(0, Math.min(15, windKmh * 0.6));
  const dryBoost = humidityPct < 50 ? Math.min(15, (50 - humidityPct) * 0.4) : 0;

  return Math.min(100, Math.round(seasonFactor * 0.65 + tempBoost + windBoost + dryBoost));
}

// 表示期間（過去日数, 未来日数）。気象は最大16日先、花粉・大気質は最大7日先まで取得可能
const RANGE_STORAGE_KEY = "weather_health_range_v1";
function getRange() {
  const v = document.getElementById("rangeSelect")?.value || "1,2";
  const [pastDays, futureDays] = v.split(",").map(Number);
  return { pastDays, futureDays };
}

async function fetchWeatherAndAllergens(lat, lon) {
  const { pastDays, futureDays } = getRange();
  // 12時間窓の計算用に過去は1日余分に取得。past_days を揃えて両APIのインデックスを一致させる
  const pastQ = pastDays + 1;
  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m` +
    `&past_days=${pastQ}&forecast_days=${Math.min(16, futureDays + 1)}&timezone=Asia%2FTokyo`;

  const airUrl =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    `&hourly=pm2_5,dust,ragweed_pollen,grass_pollen,mugwort_pollen,alder_pollen,birch_pollen` +
    `&past_days=${pastQ}&forecast_days=${Math.min(7, futureDays + 1)}&timezone=Asia%2FTokyo`;

  const [wRes, aRes] = await Promise.all([fetch(weatherUrl), fetch(airUrl)]);
  if (!wRes.ok || !aRes.ok) {
    throw new Error("気象または大気質APIの取得に失敗しました");
  }

  const wData = await wRes.json();
  const aData = await aRes.json();
  return { wData, aData };
}

function buildHourlySeries(wData, aData, user) {
  const times = wData.hourly.time;
  const nowMs = Date.now();

  // 現在時刻に最も近いインデックスを探す
  let nowIdx = 0;
  let minDiff = Infinity;
  times.forEach((t, idx) => {
    const diff = Math.abs(new Date(t).getTime() - nowMs);
    if (diff < minDiff) {
      minDiff = diff;
      nowIdx = idx;
    }
  });

  // 選択された表示期間（過去N日〜未来M日）
  const { pastDays, futureDays } = getRange();
  const startIdx = Math.max(0, nowIdx - pastDays * 24);
  const endIdx = Math.min(times.length - 1, nowIdx + futureDays * 24);

  const series = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const dt = new Date(times[i]);
    const temp = wData.hourly.temperature_2m[i];
    const humidity = wData.hourly.relative_humidity_2m[i] ?? 60;
    const pressure = wData.hourly.pressure_msl[i];
    const wind = wData.hourly.wind_speed_10m[i] ?? 0;

    const ragweedRaw = aData.hourly.ragweed_pollen?.[i] ?? 0;
    const grassRaw = aData.hourly.grass_pollen?.[i] ?? 0;
    const mugwortRaw = aData.hourly.mugwort_pollen?.[i] ?? 0;
    const alderRaw = aData.hourly.alder_pollen?.[i] ?? 0;
    const birchRaw = aData.hourly.birch_pollen?.[i] ?? 0;
    const pm25Raw = aData.hourly.pm2_5?.[i] ?? 0;
    const dustRaw = aData.hourly.dust?.[i] ?? 0;

    // 選択されたアレルゲンごとの指数（0-100）を計算
    let allergenScore = 0;
    const activeBreakdown = [];
    const allergenParts = {}; // 種類別の指数（グラフの色分け用）

    if (user.allergens.cedar) {
      const s = calcJapaneseSpringPollenIndex(dt, temp, wind, humidity, "cedar");
      allergenParts.cedar = s;
      if (s > allergenScore) allergenScore = s;
      if (s >= 40) activeBreakdown.push(`スギ(${s})`);
    }
    if (user.allergens.cypress) {
      const s = calcJapaneseSpringPollenIndex(dt, temp, wind, humidity, "cypress");
      allergenParts.cypress = s;
      if (s > allergenScore) allergenScore = s;
      if (s >= 40) activeBreakdown.push(`ヒノキ(${s})`);
    }
    if (user.allergens.ragweed) {
      const s = Math.min(100, Math.round(ragweedRaw * 1.5));
      allergenParts.ragweed = s;
      if (s > allergenScore) allergenScore = s;
      if (s >= 30) activeBreakdown.push(`ブタクサ(${s})`);
    }
    if (user.allergens.grass) {
      const s = Math.min(100, Math.round(grassRaw * 1.5));
      allergenParts.grass = s;
      if (s > allergenScore) allergenScore = s;
      if (s >= 30) activeBreakdown.push(`イネ科(${s})`);
    }
    if (user.allergens.pollen_misc) {
      const miscMax = Math.max(mugwortRaw, alderRaw, birchRaw);
      const s = Math.min(100, Math.round(miscMax * 1.5));
      allergenParts.pollen_misc = s;
      if (s > allergenScore) allergenScore = s;
      if (s >= 30) activeBreakdown.push(`ヨモギ/カバノキ等(${s})`);
    }
    if (user.allergens.pm25_dust) {
      const s = Math.min(100, Math.round(pm25Raw * 2.2 + dustRaw * 0.4));
      allergenParts.pm25_dust = s;
      if (s > allergenScore) allergenScore = s;
      if (s >= 35) activeBreakdown.push(`PM2.5/黄砂(${s})`);
    }

    // その時刻までの直近12時間の気圧低下・寒暖差から、時刻ごとの体調リスクを算出
    const winStart = Math.max(0, i - 12);
    const pWin = wData.hourly.pressure_msl.slice(winStart, i + 1).filter((v) => v != null);
    const tWin = wData.hourly.temperature_2m.slice(winStart, i + 1).filter((v) => v != null);
    const pressureDropPast12h = pWin.length ? pressure - Math.max(...pWin) : 0;
    const tempSwingPast12h = tWin.length ? Math.max(...tWin) - Math.min(...tWin) : 0;
    const hourlyRisk = calcRiskScore(pressureDropPast12h, tempSwingPast12h, allergenScore, user);

    // 気圧による頭痛リスク（3時間の変化速度 + 12時間の低下量 + 低気圧そのもの）
    const p3 = wData.hourly.pressure_msl[Math.max(0, i - 3)];
    const pressureChange3h = p3 != null && pressure != null ? pressure - p3 : 0;
    const headacheRisk = calcHeadacheScore(pressureChange3h, pressureDropPast12h, pressure);

    series.push({
      index: i,
      hourlyRisk,
      headacheRisk,
      pressureChange3h: Number(pressureChange3h.toFixed(1)),
      isNow: i === nowIdx,
      isFuture: i > nowIdx,
      label: `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, "0")}:00`,
      pressure,
      temp,
      allergenScore,
      allergenParts,
      activeBreakdown
    });
  }

  const relativeNowIdx = nowIdx - startIdx;
  return { series, relativeNowIdx };
}

// 気圧低下・寒暖差・アレルゲン指数から 0-100 のリスクスコアを計算（共通ロジック）
function calcRiskScore(pressureDrop, tempSwing, allergen, user) {
  let score = 0;
  if (pressureDrop <= user.pressureThreshold) {
    score += Math.min(45, Math.round(25 + Math.abs(pressureDrop - user.pressureThreshold) * 5));
  } else if (pressureDrop <= -2.5) {
    score += 15;
  }
  if (tempSwing >= user.tempThreshold) {
    score += Math.min(30, Math.round(15 + (tempSwing - user.tempThreshold) * 4));
  }
  if (allergen >= 60) score += 25;
  else if (allergen >= 30) score += 12;
  return Math.min(100, score);
}

// 気圧頭痛スコア（0-100）。急な気圧低下ほど頭痛が起きやすいという一般的な傾向に基づく目安
function calcHeadacheScore(change3h, drop12h, pressure) {
  let s = 0;
  if (change3h <= -3) s += 60;
  else if (change3h <= -2) s += 45;
  else if (change3h <= -1) s += 25;
  else if (change3h >= 3) s += 15; // 急上昇でも不調を感じる人がいる

  if (drop12h <= -8) s += 30;
  else if (drop12h <= -5) s += 20;
  else if (drop12h <= -3) s += 10;

  if (pressure < 1000) s += 15;
  else if (pressure < 1008) s += 8;
  return Math.min(100, s);
}

function riskLevelOf(score) {
  if (score >= 60) return { key: "danger", label: "警戒", face: "😣" };
  if (score >= 30) return { key: "warn", label: "注意", face: "😐" };
  return { key: "safe", label: "安全", face: "😊" };
}

function headacheLevelOf(score) {
  if (score >= 50) return { key: "danger", label: "頭痛注意（高）", icon: "🤕" };
  if (score >= 25) return { key: "warn", label: "頭痛やや注意", icon: "⚡" };
  return { key: "safe", label: "頭痛リスク低", icon: "" };
}

function findRiskBlock(points, key, minScore) {
  const start = points.findIndex((p) => p[key] >= minScore);
  if (start < 0) return null;
  let end = start;
  while (end + 1 < points.length && points[end + 1][key] >= minScore) end++;
  const block = points.slice(start, end + 1);
  return { from: block[0].label, to: block[block.length - 1].label, peak: Math.max(...block.map((p) => p[key])) };
}

function describeUpcomingHeadache(series, relativeNowIdx) {
  const future = series.slice(relativeNowIdx);
  const high = findRiskBlock(future, "headacheRisk", 50);
  if (high) return { cls: "danger", text: `🤕 頭痛注意：${high.from} 〜 ${high.to} は気圧低下による頭痛が起きやすい予測（最大 ${high.peak}）` };
  const mild = findRiskBlock(future, "headacheRisk", 25);
  if (mild) return { cls: "warn", text: `⚡ 頭痛やや注意：${mild.from} 〜 ${mild.to} は気圧がやや下がります（最大 ${mild.peak}）` };
  return { cls: "safe", text: "🙂 気圧による頭痛リスクは低い見込みです" };
}

// 未来の時間帯から「次に注意/警戒になる時間帯」を文章化
function describeUpcomingRisk(series, relativeNowIdx) {
  const future = series.slice(relativeNowIdx);
  const findBlock = (minScore) => findRiskBlock(future, "hourlyRisk", minScore);
  const danger = findBlock(60);
  if (danger) {
    return { cls: "danger", text: `⚠ 警戒：${danger.from} 〜 ${danger.to} に体調を崩しやすい予測です（最大リスク ${danger.peak}）` };
  }
  const warn = findBlock(30);
  if (warn) {
    return { cls: "warn", text: `△ 注意：${warn.from} 〜 ${warn.to} はやや不調に注意（最大リスク ${warn.peak}）` };
  }
  const hours = future.length - 1;
  const span = hours >= 48 ? `${Math.round(hours / 24)}日間` : `${hours}時間`;
  return { cls: "safe", text: `○ 今後${span}は大きな不調リスクは予測されていません` };
}

function evaluateRisk(series, relativeNowIdx, user) {
  const nowPoint = series[relativeNowIdx] || series[0];
  const lookaheadIdx = Math.min(series.length - 1, relativeNowIdx + 12);
  const futurePoint = series[lookaheadIdx] || nowPoint;

  // 今後12時間内の最小気圧・最大気温差をチェック
  const windowPoints = series.slice(relativeNowIdx, lookaheadIdx + 1);
  const minPressureAhead = Math.min(...windowPoints.map((p) => p.pressure));
  const maxTempAhead = Math.max(...windowPoints.map((p) => p.temp));
  const minTempAhead = Math.min(...windowPoints.map((p) => p.temp));

  const pressureDrop12h = Number((minPressureAhead - nowPoint.pressure).toFixed(1));
  const tempSwing12h = Number((maxTempAhead - minTempAhead).toFixed(1));
  const maxAllergenAhead = Math.max(...windowPoints.map((p) => p.allergenScore));

  let score = 0;
  const reasons = [];

  // 1. 気圧変動スコア（最大45点）
  if (pressureDrop12h <= user.pressureThreshold) {
    const pScore = Math.min(45, Math.round(25 + Math.abs(pressureDrop12h - user.pressureThreshold) * 5));
    score += pScore;
    reasons.push(`気圧が今後12時間で最大 ${pressureDrop12h} hPa 低下見込み（閾値: ${user.pressureThreshold} hPa）`);
  } else if (pressureDrop12h <= -2.5) {
    score += 15;
    reasons.push(`気圧が ${pressureDrop12h} hPa やや低下傾向`);
  } else {
    reasons.push(`気圧変動は比較的小さめ（12h最大変化: ${pressureDrop12h} hPa）`);
  }

  // 2. 気温差スコア（最大30点）
  if (tempSwing12h >= user.tempThreshold) {
    const tScore = Math.min(30, Math.round(15 + (tempSwing12h - user.tempThreshold) * 4));
    score += tScore;
    reasons.push(`12時間内の気温差が ${tempSwing12h} ℃ と大きめ（閾値: ${user.tempThreshold} ℃）`);
  } else {
    reasons.push(`気温差は許容範囲内（12h内差: ${tempSwing12h} ℃）`);
  }

  // 3. 選択アレルゲン・季節要因スコア（最大25点）
  if (maxAllergenAhead >= 60) {
    score += 25;
    reasons.push(`選択中の花粉・季節リスクが高い時間帯あり（最大指数: ${maxAllergenAhead}）`);
  } else if (maxAllergenAhead >= 30) {
    score += 12;
    reasons.push(`選択中の花粉・季節リスクにやや注意（最大指数: ${maxAllergenAhead}）`);
  } else {
    reasons.push(`選択中の花粉・季節リスクは低め（最大指数: ${maxAllergenAhead}）`);
  }

  score = Math.min(100, score);

  let level = "安全";
  let bannerClass = "";
  let summary = "急激な変動や高い花粉リスクは見られません。";

  if (score >= 60) {
    level = "警戒（不調リスク高）";
    bannerClass = "danger";
    summary = "気圧低下・寒暖差・選択花粉のいずれか、または複合的な負荷が高まっています。";
  } else if (score >= 30) {
    level = "注意（やや不調に注意）";
    bannerClass = "warn";
    summary = "体調変化やアレルギー症状が出やすい時間帯があります。";
  }

  return {
    score,
    level,
    bannerClass,
    summary,
    reasons,
    currentPressure: nowPoint.pressure,
    currentTemp: nowPoint.temp,
    futureTimeLabel: futurePoint.label
  };
}

function renderRiskUI(risk) {
  const banner = document.getElementById("riskBanner");
  banner.className = `risk-banner ${risk.bannerClass}`.trim();

  document.getElementById("riskLabel").textContent = risk.level;
  document.getElementById("riskSummary").textContent = risk.summary;
  document.getElementById("riskScore").textContent = `${risk.score}`;

  const list = document.getElementById("reasonsList");
  list.innerHTML = risk.reasons.map((r) => `<li>・${r}</li>`).join("");
}

// グラフ背景に時刻ごとのリスク帯（黄=注意 / 赤=警戒）と「現在」線を描くプラグイン
const riskBandPlugin = {
  id: "riskBands",
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea, scales } = chart;
    const pts = opts.series || [];
    if (!pts.length) return;
    const x = scales.x;
    const step = pts.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : chartArea.width;
    ctx.save();
    clipToArea(ctx, chartArea);
    pts.forEach((p, i) => {
      const lv = riskLevelOf(p.hourlyRisk).key;
      if (lv === "safe") return;
      const cx = x.getPixelForValue(i);
      ctx.fillStyle = lv === "danger" ? "rgba(239, 68, 68, 0.22)" : "rgba(234, 179, 8, 0.14)";
      const left = Math.max(chartArea.left, cx - step / 2);
      const right = Math.min(chartArea.right, cx + step / 2);
      if (right <= left) return; // 表示範囲外
      ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
    });
    const nx = opts.nowIdx != null ? x.getPixelForValue(opts.nowIdx) : NaN;
    if (nx >= chartArea.left && nx <= chartArea.right) {
      ctx.strokeStyle = "rgba(248, 250, 252, 0.8)";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(nx, chartArea.top);
      ctx.lineTo(nx, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#f8fafc";
      ctx.font = `bold ${UI().small - 1}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("現在", nx, chartArea.bottom - 6);
      ctx.fillStyle = "#94a3b8";
      ctx.fillText("予測 →", nx + 32, chartArea.bottom - 6);
    }
    ctx.restore();
  },

  // グラフ上部に一定時間ごとの「顔」（体調）と頭痛アイコンを並べる
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea, scales } = chart;
    const pts = opts.series || [];
    if (!pts.length) return;
    const x = scales.x;
    // アイコンが重ならないよう、画面幅に応じて 3/6/12/24 時間間隔から自動選択
    const pxPerHour = pts.length > 1 ? (x.getPixelForValue(pts.length - 1) - x.getPixelForValue(0)) / (pts.length - 1) : 40;
    const block = [3, 6, 12, 24].find((h) => h * pxPerHour >= UI().iconGap) || 24;
    const FACE_Y = chartArea.top + UI().faceY;
    const HEAD_Y = chartArea.top + UI().headY;
    const emojiFont = "'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif";

    ctx.save();
    clipToArea(ctx, chartArea);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // 行ラベル
    ctx.font = `bold ${UI().small}px sans-serif`;
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "left";
    ctx.fillText("体調", chartArea.left + 4, FACE_Y);
    ctx.fillText("頭痛", chartArea.left + 4, HEAD_Y);
    ctx.textAlign = "center";

    for (let s = 0; s < pts.length; s += block) {
      const e = Math.min(pts.length - 1, s + block - 1);
      const seg = pts.slice(s, e + 1);
      const cx = (x.getPixelForValue(s) + x.getPixelForValue(e)) / 2;
      if (cx < chartArea.left + UI().labelPad || cx > chartArea.right) continue; // 範囲外・行ラベルと重なる位置は省略

      const maxRisk = Math.max(...seg.map((p) => p.hourlyRisk));
      const maxHead = Math.max(...seg.map((p) => p.headacheRisk));
      const lv = riskLevelOf(maxRisk);
      const hv = headacheLevelOf(maxHead);
      const isPast = !seg.some((p) => p.isFuture || p.isNow);

      ctx.globalAlpha = isPast ? 0.5 : 1; // 過去は薄く、予測部分をはっきり
      ctx.font = `${UI().face}px ${emojiFont}`;
      ctx.fillText(lv.face, cx, FACE_Y);
      if (hv.icon) {
        ctx.font = `${UI().head}px ${emojiFont}`;
        ctx.fillText(hv.icon, cx, HEAD_Y);
      } else {
        ctx.fillStyle = "rgba(148, 163, 184, 0.5)";
        ctx.font = "14px sans-serif";
        ctx.fillText("・", cx, HEAD_Y);
      }
    }
    ctx.restore();
  }
};

// 花粉の種類ごとの表示名・色
const POLLEN_STYLE = {
  cedar: { name: "スギ", color: "#16a34a" },
  cypress: { name: "ヒノキ", color: "#86efac" },
  ragweed: { name: "ブタクサ", color: "#f59e0b" },
  grass: { name: "イネ科", color: "#2dd4bf" },
  pollen_misc: { name: "ヨモギ/カバノキ等", color: "#c084fc" },
  pm25_dust: { name: "PM2.5/黄砂", color: "#94a3b8" }
};

function pollenLevelOf(score) {
  if (score >= 60) return { key: "danger", label: "つらい", face: "😫" };
  if (score >= 30) return { key: "warn", label: "症状に注意", face: "🤧" };
  return { key: "safe", label: "少ない", face: "😊" };
}

// 花粉グラフの上部に、一定時間ごとの顔と「主な原因の種類」を表示
const pollenFacePlugin = {
  id: "pollenFaces",
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea, scales } = chart;
    const pts = opts.series || [];
    if (!pts.length) return;
    const x = scales.x;
    const pxPerHour = pts.length > 1 ? (x.getPixelForValue(pts.length - 1) - x.getPixelForValue(0)) / (pts.length - 1) : 40;
    const block = [3, 6, 12, 24].find((h) => h * pxPerHour >= UI().iconGap) || 24;
    const emojiFont = "'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif";
    const FACE_Y = chartArea.top + UI().faceY;
    const NAME_Y = chartArea.top + UI().nameY;

    ctx.save();
    clipToArea(ctx, chartArea);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let s = 0; s < pts.length; s += block) {
      const e = Math.min(pts.length - 1, s + block - 1);
      const seg = pts.slice(s, e + 1);
      const cx = (x.getPixelForValue(s) + x.getPixelForValue(e)) / 2;
      if (cx < chartArea.left || cx > chartArea.right) continue;
      const peak = seg.reduce((a, p) => (p.allergenScore > a.allergenScore ? p : a), seg[0]);
      const lv = pollenLevelOf(peak.allergenScore);
      const isPast = !seg.some((p) => p.isFuture || p.isNow);

      ctx.globalAlpha = isPast ? 0.5 : 1;
      ctx.font = `${UI().face}px ${emojiFont}`;
      ctx.fillText(lv.face, cx, FACE_Y);

      // 指数30以上のときは一番多い種類を色付きで表示
      if (peak.allergenScore >= 30) {
        const parts = peak.allergenParts || {};
        const topKey = (opts.activeKeys || []).reduce((a, k) => ((parts[k] || 0) > (parts[a] || 0) ? k : a), opts.activeKeys[0]);
        if (topKey) {
          ctx.font = `bold ${UI().small - 1}px sans-serif`;
          ctx.fillStyle = POLLEN_STYLE[topKey].color;
          ctx.fillText(POLLEN_STYLE[topKey].name.split("/")[0], cx, NAME_Y);
        }
      }
    }
    ctx.restore();
  }
};

// 線グラフの上に顔アイコン2段分（約35%）の余白を作る軸範囲
function headroom(values) {
  const v = values.filter((n) => n != null);
  if (!v.length) return {};
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const range = Math.max(hi - lo, 1);
  return { min: Math.floor(lo - range * 0.05), max: Math.ceil(hi + range * 0.6) };
}

// 画面幅に応じたグラフの文字・アイコンサイズ（スマホでは小さめ・間隔広め）
function isMobile() {
  return window.matchMedia("(max-width: 640px)").matches;
}
function UI() {
  return isMobile()
    ? { face: 24, head: 20, faceY: 18, headY: 46, nameY: 38, small: 11, labelPad: 34, iconGap: 30, tick: 10, legendBox: 12, xTicks: 5 }
    : { face: 32, head: 26, faceY: 24, headY: 62, nameY: 46, small: 12, labelPad: 46, iconGap: 40, tick: 12, legendBox: 30, xTicks: 12 };
}

function clipToArea(ctx, area) {
  ctx.beginPath();
  ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
  ctx.clip();
}

// 指スライド・ピンチズームの設定（2つのグラフの表示範囲を連動させる）
let currentWindow = null;
function zoomOptions(len) {
  const sync = ({ chart }) => syncWindowFrom(chart);
  return {
    pan: { enabled: true, mode: "x", threshold: 5, onPan: sync, onPanComplete: sync },
    zoom: {
      pinch: { enabled: true },
      wheel: { enabled: true, modifierKey: "ctrl" }, // PCは Ctrl+ホイールでズーム
      mode: "x",
      onZoom: sync,
      onZoomComplete: sync
    },
    limits: { x: { min: 0, max: len - 1, minRange: 6 } }
  };
}

function syncWindowFrom(chart) {
  const { min, max } = chart.scales.x;
  currentWindow = { min, max };
  [weatherChart, pollenChart].forEach((c) => {
    if (!c || c === chart) return;
    c.options.scales.x.min = min;
    c.options.scales.x.max = max;
    c.update("none");
  });
  updateWindowLabel();
}

function setWindow(min, max) {
  const len = lastRender?.series.length || 0;
  if (!len) return;
  const span = max - min;
  if (min < 0) { min = 0; max = Math.min(len - 1, span); }
  if (max > len - 1) { max = len - 1; min = Math.max(0, max - span); }
  currentWindow = { min, max };
  [weatherChart, pollenChart].forEach((c) => {
    if (!c) return;
    c.options.scales.x.min = min;
    c.options.scales.x.max = max;
    c.update();
  });
  updateWindowLabel();
}

function defaultWindow(len, nowIdx) {
  // スマホは48時間、PCは72時間ぶんを最初に表示（現在の少し前から）
  const before = isMobile() ? 12 : 24;
  const after = isMobile() ? 36 : 48;
  let min = Math.max(0, nowIdx - before);
  let max = Math.min(len - 1, nowIdx + after);
  return { min, max };
}

function updateWindowLabel() {
  const el = document.getElementById("windowLabel");
  if (!el || !lastRender || !currentWindow) return;
  const s = lastRender.series;
  const a = s[Math.max(0, Math.round(currentWindow.min))];
  const b = s[Math.min(s.length - 1, Math.round(currentWindow.max))];
  if (a && b) el.textContent = `表示中: ${a.label} 〜 ${b.label}`;
}

let lastRender = null;
let lastMobile = null;
window.addEventListener("resize", () => {
  clearTimeout(window.__resizeTimer);
  window.__resizeTimer = setTimeout(() => {
    // スマホの縦横切り替えなどで表示モードが変わったら描き直す
    if (lastRender && isMobile() !== lastMobile) renderCharts(lastRender.series, lastRender.relativeNowIdx, true);
  }, 250);
});

function renderCharts(series, relativeNowIdx, keepWindow = false) {
  lastRender = { series, relativeNowIdx };
  lastMobile = isMobile();
  const win = keepWindow && currentWindow ? currentWindow : defaultWindow(series.length, relativeNowIdx);
  currentWindow = win;
  const labels = series.map((d) => d.label);
  const pressures = series.map((d) => d.pressure);
  const temps = series.map((d) => d.temp);
  const allergenScores = series.map((d) => d.allergenScore);
  const risks = series.map((d) => d.hourlyRisk);
  const ptRadius = series.length > 120 ? 0 : 2; // 長期間表示では点を省略して見やすく
  // 顔アイコンの間隔（全体で20個前後になるように 3/6/12/24 時間から選ぶ）
  const blockHours = [3, 6, 12, 24].find((h) => series.length / h <= 26) || 24;

  const weatherCtx = document.getElementById("weatherChart").getContext("2d");
  if (weatherChart) weatherChart.destroy();

  weatherChart = new Chart(weatherCtx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "海面気圧 (hPa)",
          data: pressures,
          yAxisID: "yPressure",
          borderColor: "#38bdf8",
          backgroundColor: "rgba(56, 189, 248, 0.15)",
          tension: 0.3,
          pointRadius: ptRadius
        },
        {
          label: "気温 (℃)",
          data: temps,
          yAxisID: "yTemp",
          borderColor: "#fb923c",
          backgroundColor: "rgba(251, 146, 60, 0.15)",
          tension: 0.3,
          pointRadius: ptRadius
        },
        {
          label: "体調リスク予測 (0-100)",
          data: risks,
          yAxisID: "yRisk",
          borderColor: "#f472b6",
          backgroundColor: "rgba(244, 114, 182, 0.15)",
          borderDash: [6, 4],
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 0
        }
      ]
    },
    plugins: [riskBandPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: UI().legendBox, font: { size: UI().tick + 1 } } },
        riskBands: { series, nowIdx: relativeNowIdx, blockHours },
        zoom: zoomOptions(series.length),
        tooltip: {
          callbacks: {
            afterBody(items) {
              const p = series[items[0].dataIndex];
              const lv = riskLevelOf(p.hourlyRisk);
              const hv = headacheLevelOf(p.headacheRisk);
              const sign = p.pressureChange3h > 0 ? "+" : "";
              return [
                `${lv.face} 体調予測: ${lv.label}（${p.hourlyRisk}）${p.isFuture ? " ※予測" : ""}`,
                `${hv.icon || "🙂"} ${hv.label}（${p.headacheRisk}） 3h気圧変化: ${sign}${p.pressureChange3h} hPa`
              ];
            }
          }
        }
      },
      scales: {
        x: { min: win.min, max: win.max, ticks: { color: "#94a3b8", maxTicksLimit: UI().xTicks, maxRotation: 0, font: { size: UI().tick } }, grid: { color: "#1e293b" } },
        // 上部に顔アイコン用の余白を確保するため、各軸の上側にゆとりを持たせる
        yRisk: { type: "linear", display: false, min: 0, max: 160 },
        yPressure: {
          type: "linear",
          position: "left",
          ...headroom(pressures),
          ticks: { color: "#38bdf8", precision: 0, font: { size: UI().tick } },
          grid: { color: "rgba(148, 163, 184, 0.15)" }
        },
        yTemp: {
          type: "linear",
          position: "right",
          ...headroom(temps),
          ticks: { color: "#fb923c", precision: 0, font: { size: UI().tick } },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });

  const pollenCtx = document.getElementById("pollenChart").getContext("2d");
  if (pollenChart) pollenChart.destroy();

  // 種類別に色分けした積み上げ棒。棒全体の高さ＝総合指数、色の比率＝各種類の割合
  const user = getCurrentUser();
  const activeKeys = ALLERGEN_DEFS.map((d) => d.key).filter((k) => user.allergens[k]);
  const pollenDatasets = activeKeys.map((key) => ({
    label: POLLEN_STYLE[key].name,
    data: series.map((p) => {
      const parts = p.allergenParts || {};
      const sum = activeKeys.reduce((a, k) => a + (parts[k] || 0), 0);
      return sum > 0 ? Number(((p.allergenScore * (parts[key] || 0)) / sum).toFixed(1)) : 0;
    }),
    backgroundColor: POLLEN_STYLE[key].color,
    borderWidth: 0,
    stack: "pollen"
  }));

  pollenChart = new Chart(pollenCtx, {
    type: "bar",
    data: { labels, datasets: pollenDatasets },
    plugins: [pollenFacePlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: UI().legendBox, font: { size: UI().tick + 1 } } },
        pollenFaces: { series, activeKeys },
        zoom: zoomOptions(series.length),
        tooltip: {
          callbacks: {
            // 割合ではなく各種類の実際の指数を表示
            label(item) {
              const key = activeKeys[item.datasetIndex];
              const raw = series[item.dataIndex].allergenParts?.[key] ?? 0;
              return `${POLLEN_STYLE[key].name}: 指数 ${raw}`;
            },
            afterBody(items) {
              const p = series[items[0].dataIndex];
              const lv = pollenLevelOf(p.allergenScore);
              return `${lv.face} 総合: ${lv.label}（${p.allergenScore}）${p.isFuture ? " ※予測" : ""}`;
            }
          }
        }
      },
      scales: {
        x: { stacked: true, min: win.min, max: win.max, ticks: { color: "#94a3b8", maxTicksLimit: UI().xTicks, maxRotation: 0, font: { size: UI().tick } }, grid: { color: "#1e293b" } },
        y: {
          stacked: true,
          min: 0,
          max: 140, // 上部に顔アイコン用の余白
          ticks: { color: "#cbd5e1", stepSize: 20, font: { size: UI().tick }, callback: (v) => (v <= 100 ? v : "") },
          grid: { color: "rgba(148, 163, 184, 0.15)" }
        }
      }
    }
  });

  // ズームプラグイン（Hammer.js）はグラフ上の縦スクロールを止めてしまうため、
  // 縦方向はページのスクロール、横スライドと2本指ズームはグラフ操作になるよう上書き
  [weatherChart, pollenChart].forEach((c) => {
    if (c?.canvas) c.canvas.style.touchAction = "pan-y";
  });

  updateWindowLabel();
}

async function refreshAll() {
  const user = getCurrentUser();
  const metaEl = document.getElementById("statusMeta");
  metaEl.textContent = `${user.name}（${user.locationName}）のデータを取得中...`;

  try {
    const { wData, aData } = await fetchWeatherAndAllergens(user.lat, user.lon);
    const { series, relativeNowIdx } = buildHourlySeries(wData, aData, user);
    const risk = evaluateRisk(series, relativeNowIdx, user);

    latestSnapshot = {
      currentPressure: risk.currentPressure,
      currentTemp: risk.currentTemp,
      riskScore: risk.score
    };

    // 今後12時間の気圧頭痛リスクを判定カードにも追加
    const next12 = series.slice(relativeNowIdx, relativeNowIdx + 13);
    const headPeak = next12.reduce((a, p) => (p.headacheRisk > a.headacheRisk ? p : a), next12[0]);
    const hv = headacheLevelOf(headPeak.headacheRisk);
    risk.reasons.unshift(
      hv.key === "safe"
        ? `🙂 気圧による頭痛リスクは低め（今後12hの最大: ${headPeak.headacheRisk}）`
        : `${hv.icon} ${hv.label}：${headPeak.label} 頃がピーク（頭痛指数 ${headPeak.headacheRisk}）`
    );

    renderRiskUI(risk);
    renderCharts(series, relativeNowIdx);

    const upcoming = describeUpcomingRisk(series, relativeNowIdx);
    const fcEl = document.getElementById("riskForecast");
    fcEl.className = `risk-forecast ${upcoming.cls}`;
    fcEl.textContent = upcoming.text;

    const head = describeUpcomingHeadache(series, relativeNowIdx);
    const hdEl = document.getElementById("headacheForecast");
    hdEl.className = `risk-forecast ${head.cls}`;
    hdEl.textContent = head.text;

    metaEl.textContent =
      `対象: ${user.locationName}（${user.name}） | 現在 気圧: ${risk.currentPressure} hPa / 気温: ${risk.currentTemp} ℃ | 更新: ${new Date().toLocaleTimeString("ja-JP")}`;
  } catch (err) {
    metaEl.textContent = `取得エラー: ${err.message}`;
  }
}

function updateRangeTitle() {
  const { pastDays, futureDays } = getRange();
  const fmt = (d) => (d <= 2 ? `${d * 24}時間` : `${d}日`);
  document.getElementById("weatherChartTitle").textContent =
    `気圧（hPa）＆ 気温（℃）推移（過去${fmt(pastDays)} 〜 未来${fmt(futureDays)}）`;
  document.getElementById("pollenNote").textContent =
    futureDays > 6 ? "※ブタクサ・イネ科・PM2.5等のAPI予報は約7日先まで（それ以降は0表示）。スギ・ヒノキは季節補正で算出。" : "";
}

function bindEvents() {
  document.getElementById("userSelect").addEventListener("change", (e) => {
    currentUserId = e.target.value;
    renderUserSettingsForm();
    refreshAll();
  });

  document.getElementById("addUserBtn").addEventListener("click", () => {
    const name = prompt("新しいユーザー名を入力してください（例: 家族A、秋花粉用など）");
    if (!name || !name.trim()) return;
    const newUser = {
      id: `user_${Date.now()}`,
      name: name.trim(),
      lat: 35.728,
      lon: 139.477,
      locationName: "東京都小平市",
      pressureThreshold: -5.0,
      tempThreshold: 7.0,
      allergens: {
        cedar: true,
        cypress: false,
        ragweed: false,
        grass: false,
        pollen_misc: false,
        pm25_dust: true
      }
    };
    users.push(newUser);
    currentUserId = newUser.id;
    saveUsers();
    renderUserSelector();
    renderUserSettingsForm();
    refreshAll();
  });

  document.getElementById("saveSettingsBtn").addEventListener("click", () => {
    const user = getCurrentUser();
    const checkboxes = document.querySelectorAll('#allergenGrid input[type="checkbox"]');
    checkboxes.forEach((cb) => {
      const key = cb.getAttribute("data-allergen");
      user.allergens[key] = cb.checked;
    });

    user.pressureThreshold = parseFloat(document.getElementById("pressureThreshold").value) || -5.0;
    user.tempThreshold = parseFloat(document.getElementById("tempThreshold").value) || 7.0;

    const [latStr, lonStr, locName] = document.getElementById("locationSelect").value.split(",");
    user.lat = parseFloat(latStr);
    user.lon = parseFloat(lonStr);
    user.locationName = locName;

    saveUsers();
    refreshAll();
  });

  document.getElementById("refreshBtn").addEventListener("click", refreshAll);

  // 表示範囲の移動ボタン（スライドが苦手な場合・PC用）
  const shift = (dir) => {
    if (!currentWindow) return;
    const span = currentWindow.max - currentWindow.min;
    const d = Math.round(span * 0.75) * dir;
    setWindow(currentWindow.min + d, currentWindow.max + d);
  };
  document.getElementById("panPrevBtn").addEventListener("click", () => shift(-1));
  document.getElementById("panNextBtn").addEventListener("click", () => shift(1));
  document.getElementById("panNowBtn").addEventListener("click", () => {
    if (!lastRender) return;
    const w = defaultWindow(lastRender.series.length, lastRender.relativeNowIdx);
    setWindow(w.min, w.max);
  });
  document.getElementById("panAllBtn").addEventListener("click", () => {
    if (!lastRender) return;
    setWindow(0, lastRender.series.length - 1);
  });

  const rangeSel = document.getElementById("rangeSelect");
  try {
    const saved = localStorage.getItem(RANGE_STORAGE_KEY);
    if (saved && Array.from(rangeSel.options).some((o) => o.value === saved)) rangeSel.value = saved;
  } catch {}
  updateRangeTitle();
  rangeSel.addEventListener("change", () => {
    try { localStorage.setItem(RANGE_STORAGE_KEY, rangeSel.value); } catch {}
    updateRangeTitle();
    refreshAll();
  });

  document.querySelectorAll(".log-buttons button").forEach((btn) => {
    btn.addEventListener("click", () => {
      saveLog(btn.getAttribute("data-cond"));
    });
  });
}

// 初期化
renderUserSelector();
renderUserSettingsForm();
renderLogs();
bindEvents();
refreshAll();
