//RAY BUILD 
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { CallbackQuery } = require("telegram/events/CallbackQuery");
const { Button } = require("telegram/tl/custom/button");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const os = require("os");
const { execSync } = require("child_process");
const net = require("net");

const CONFIG = require("./config");
const {
  getUserJob, setUserJob, removeUserJob, isUserBuilding,
  getActiveJobs, getQueueStats,
} = require("./zip");
const {
  uploadZipToRelease, deleteRelease, triggerWorkflow, getRunStatus,
  getArtifacts, downloadArtifactZip, getFailedStepLog, sleep,
  createReleaseOnly, uploadAssetFile, triggerWeb2ApkWorkflow, publishRelease,
} = require("./server");

// ─── CLIENT ──────────────────────────────────────────────────────────────────
const SESSION_FILE = "./session.txt";
const sessionString = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, "utf8").trim() : "";
const API_ID = parseInt(process.env.API_ID || "36242737");
const API_HASH = process.env.API_HASH || "904e85ba2506348c1801cd1db421816c";
const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5 });

// ─── STATE ──────────────────────────────────────────────────────────────────
const userStates = new Map();
const adminStates = new Map();

// ─── FILE PATHS ─────────────────────────────────────────────────────────────
const DB_PATH          = "./users.json";
const STATS_PATH       = "./stats.json";
const RESELLER_PATH    = "./resellers.json";
const BANNED_PATH      = "./banned.json";
const HISTORY_PATH     = "./buildhistory.json";
const MAINTENANCE_PATH = "./maintenance.json";
const CREDIT_PATH      = "./credits.json";
const WEEKLY_PATH      = "./weekly.json";
const PREMIUM_PATH     = "./premium.json";
const PAYMENTS_PATH    = "./payments.json";
const PAYMENT_CONFIG_PATH = "./paymentconfig.json"; // baru

function ensureJson(p, def) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def, null, 2));
}
ensureJson(DB_PATH,          []);
ensureJson(STATS_PATH,       { success: 0, failed: 0 });
ensureJson(RESELLER_PATH,    []);
ensureJson(BANNED_PATH,      []);
ensureJson(HISTORY_PATH,     []);
ensureJson(MAINTENANCE_PATH, { enabled: false, reason: "" });
ensureJson(CREDIT_PATH,      []);
ensureJson(WEEKLY_PATH,      {});
ensureJson(PREMIUM_PATH,     []);
ensureJson(PAYMENTS_PATH,    []);
ensureJson(PAYMENT_CONFIG_PATH, { qrisPath: null, instructions: "Bayar via QRIS di bawah ini, lalu kirim bukti transfer ke bot." });

// ─── DB ─────────────────────────────────────────────────────────────────────
const db = {
  getAllUsers:    ()       => JSON.parse(fs.readFileSync(DB_PATH, "utf-8")),
  getUserById:   (id)     => db.getAllUsers().find(u => u.userId === Number(id)),
  upsertUser(data) {
    const all = db.getAllUsers();
    const i = all.findIndex(u => u.userId === data.userId);
    if (i !== -1) { all[i] = { ...all[i], ...data, lastActive: new Date() }; }
    else { all.push({ ...data, joinedAt: new Date(), lastActive: new Date() }); }
    fs.writeFileSync(DB_PATH, JSON.stringify(all, null, 2));
    return i === -1;
  },
  deleteUser(id) {
    const all = db.getAllUsers();
    const filtered = all.filter(u => u.userId !== Number(id));
    if (filtered.length === all.length) return false;
    fs.writeFileSync(DB_PATH, JSON.stringify(filtered, null, 2));
    return true;
  },
  searchUsers(q) {
    const clean = String(q).toLowerCase().replace("@", "");
    return db.getAllUsers().filter(u =>
      String(u.userId).includes(clean) ||
      (u.username && u.username.toLowerCase().replace("@", "").includes(clean)) ||
      (u.name && u.name.toLowerCase().includes(clean))
    );
  },

  getStats()       { return JSON.parse(fs.readFileSync(STATS_PATH, "utf-8")); },
  incrementStat(t) {
    const s = db.getStats();
    s[t] = (s[t] || 0) + 1;
    fs.writeFileSync(STATS_PATH, JSON.stringify(s, null, 2));
    return s;
  },
  resetStats() {
    const s = { success: 0, failed: 0 };
    fs.writeFileSync(STATS_PATH, JSON.stringify(s, null, 2));
    return s;
  },

  blockedReportUsers: new Set(),
  isReportBlocked(id) { return this.blockedReportUsers.has(Number(id)); },
  blockReportUser(id) { this.blockedReportUsers.add(Number(id)); },
  unblockReportUser(id) { this.blockedReportUsers.delete(Number(id)); },
};

// ─── RESELLERS ──────────────────────────────────────────────────────────────
const rdb = {
  all()         { return JSON.parse(fs.readFileSync(RESELLER_PATH, "utf-8")); },
  save(list)    { fs.writeFileSync(RESELLER_PATH, JSON.stringify(list, null, 2)); },
  isReseller(id){ return rdb.all().some(r => r.userId === Number(id)); },
  add(id, username, addedBy) {
    const list = rdb.all();
    if (list.some(r => r.userId === Number(id))) return false;
    list.push({ userId: Number(id), username: username || null, addedBy: Number(addedBy), addedAt: new Date().toISOString() });
    rdb.save(list);
    return true;
  },
  remove(id) {
    const list = rdb.all();
    const f = list.filter(r => r.userId !== Number(id));
    if (f.length === list.length) return false;
    rdb.save(f);
    return true;
  },
};

// ─── PREMIUM DB ─────────────────────────────────────────────────────────────
const pdb = {
  all()          { return JSON.parse(fs.readFileSync(PREMIUM_PATH, "utf-8")); },
  save(list)     { fs.writeFileSync(PREMIUM_PATH, JSON.stringify(list, null, 2)); },
  isPremium(id)  { return pdb.all().some(p => p.userId === Number(id)); },
  add(id, username, addedBy, note = "") {
    const list = pdb.all();
    if (list.some(p => p.userId === Number(id))) return false;
    list.push({ userId: Number(id), username: username || null, addedBy: Number(addedBy), note, addedAt: new Date().toISOString() });
    pdb.save(list); return true;
  },
  remove(id) {
    const list = pdb.all();
    const f    = list.filter(p => p.userId !== Number(id));
    if (f.length === list.length) return false;
    pdb.save(f); return true;
  },
};

// ─── BANNED ─────────────────────────────────────────────────────────────────
const bdb = {
  all()       { return JSON.parse(fs.readFileSync(BANNED_PATH, "utf-8")); },
  save(list)  { fs.writeFileSync(BANNED_PATH, JSON.stringify(list, null, 2)); },
  isBanned(id){ return bdb.all().some(b => b.userId === Number(id)); },
  ban(id, reason, bannedBy) {
    const list = bdb.all();
    if (list.some(b => b.userId === Number(id))) return false;
    list.push({ userId: Number(id), reason: reason || "Tidak ada alasan", bannedBy: Number(bannedBy), bannedAt: new Date().toISOString() });
    bdb.save(list);
    return true;
  },
  unban(id) {
    const list = bdb.all();
    const f = list.filter(b => b.userId !== Number(id));
    if (f.length === list.length) return false;
    bdb.save(f);
    return true;
  },
  getInfo(id) { return bdb.all().find(b => b.userId === Number(id)); },
};

// ─── BUILD HISTORY ──────────────────────────────────────────────────────────
const hdb = {
  all()     { return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8")); },
  save(l)   { fs.writeFileSync(HISTORY_PATH, JSON.stringify(l, null, 2)); },
  add(entry) {
    const list = hdb.all();
    list.unshift({ ...entry, id: Date.now() });
    if (list.length > 500) list.splice(500);
    hdb.save(list);
  },
};

// ─── MAINTENANCE ────────────────────────────────────────────────────────────
const mdb = {
  get()          { return JSON.parse(fs.readFileSync(MAINTENANCE_PATH, "utf-8")); },
  save(d)        { fs.writeFileSync(MAINTENANCE_PATH, JSON.stringify(d, null, 2)); },
  isEnabled()    { return mdb.get().enabled; },
  toggle(reason) {
    const d = mdb.get();
    d.enabled = !d.enabled;
    d.reason = reason || "";
    mdb.save(d);
    return d.enabled;
  },
  setReason(r) {
    const d = mdb.get();
    d.reason = r;
    mdb.save(d);
  },
};

// ─── CREDIT SYSTEM ──────────────────────────────────────────────────────────
const cdb = {
  all()         { return JSON.parse(fs.readFileSync(CREDIT_PATH, "utf-8")); },
  save(list)    { fs.writeFileSync(CREDIT_PATH, JSON.stringify(list, null, 2)); },
  get(id)       { return cdb.all().find(c => c.userId === Number(id)) || null; },
  getCredit(id) { const r = cdb.get(id); return r ? r.credit : 0; },
  setCredit(id, amount, grantedBy = null) {
    const list = cdb.all();
    const idx  = list.findIndex(c => c.userId === Number(id));
    if (idx !== -1) {
      list[idx].credit    = Math.max(0, amount);
      list[idx].updatedAt = new Date().toISOString();
    } else {
      list.push({ userId: Number(id), credit: Math.max(0, amount), grantedBy: grantedBy ? Number(grantedBy) : null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    cdb.save(list);
  },
  addCredit(id, amount, grantedBy = null) {
    const cur = cdb.getCredit(id);
    cdb.setCredit(id, cur + amount, grantedBy);
    return cur + amount;
  },
  deductCredit(id) {
    const cur = cdb.getCredit(id);
    if (cur <= 0) return false;
    cdb.setCredit(id, cur - 1);
    return true;
  },
  hasCredit(id) { return cdb.getCredit(id) > 0; },
  remove(id)    { cdb.save(cdb.all().filter(c => c.userId !== Number(id))); },
};

// ─── WEEKLY CREDIT DB ──────────────────────────────────────────────────────
const wdb = {
  all()       { return JSON.parse(fs.readFileSync(WEEKLY_PATH, "utf-8")); },
  save(d)     { fs.writeFileSync(WEEKLY_PATH, JSON.stringify(d, null, 2)); },
  getLastClaim(id) {
    const d = wdb.all();
    return d[String(id)] ? new Date(d[String(id)]) : null;
  },
  setClaim(id) {
    const d = wdb.all();
    d[String(id)] = new Date().toISOString();
    wdb.save(d);
  },
  canClaim(id) {
    const last = wdb.getLastClaim(id);
    if (!last) return true;
    const diff = Date.now() - last.getTime();
    return diff >= 7 * 24 * 60 * 60 * 1000; // 7 hari
  },
  nextClaimMs(id) {
    const last = wdb.getLastClaim(id);
    if (!last) return 0;
    const next = last.getTime() + 7 * 24 * 60 * 60 * 1000;
    return Math.max(0, next - Date.now());
  },
  nextClaimStr(id) {
    const ms = wdb.nextClaimMs(id);
    if (ms <= 0) return "Sekarang!";
    const d  = Math.floor(ms / 86400000);
    const h  = Math.floor((ms % 86400000) / 3600000);
    const m  = Math.floor((ms % 3600000)  / 60000);
    const parts = [];
    if (d) parts.push(`${d} hari`);
    if (h) parts.push(`${h} jam`);
    if (m) parts.push(`${m} menit`);
    return parts.join(" ") || "< 1 menit";
  },
};

// ─── PAYMENT DB ─────────────────────────────────────────────────────────────
const paydb = {
  all()         { return JSON.parse(fs.readFileSync(PAYMENTS_PATH, "utf-8")); },
  save(list)    { fs.writeFileSync(PAYMENTS_PATH, JSON.stringify(list, null, 2)); },
  get(id)       { return paydb.all().find(p => p.id === id); },
  create(userId, packageName, creditAmount, price) {
    const list = paydb.all();
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    const entry = {
      id,
      userId: Number(userId),
      package: packageName,
      credit: creditAmount,
      price,
      status: "pending", // pending | approved | rejected
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    list.push(entry);
    paydb.save(list);
    return entry;
  },
  update(id, data) {
    const list = paydb.all();
    const idx = list.findIndex(p => p.id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...data, updatedAt: new Date().toISOString() };
    paydb.save(list);
    return list[idx];
  },
  getPending() { return paydb.all().filter(p => p.status === "pending"); },
  getByUser(userId) { return paydb.all().filter(p => p.userId === Number(userId)); },
};

// ─── PAYMENT CONFIG ─────────────────────────────────────────────────────────
function getPaymentConfig() {
  return JSON.parse(fs.readFileSync(PAYMENT_CONFIG_PATH, "utf-8"));
}
function savePaymentConfig(config) {
  fs.writeFileSync(PAYMENT_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── UTILS ──────────────────────────────────────────────────────────────────
function isAdmin(id)    { return CONFIG.ADMIN_IDS.includes(Number(id)); }
function isOwner(id)    { return Number(id) === Number(CONFIG.OWNER_ID); }
function isPrivileged(id){ return isAdmin(id) || isOwner(id); }
function isCreditExempt(id) { return isOwner(id) || isAdmin(id) || rdb.isReseller(id) || pdb.isPremium(id); }

function getUserPriority(id) {
  if (isOwner(id))         return 1;
  if (rdb.isReseller(id))  return 2;
  return 3;
}

function getSortedActiveJobs() {
  return getActiveJobs().sort((a, b) => {
    const pa = a.priority || getUserPriority(a.userId);
    const pb = b.priority || getUserPriority(b.userId);
    return pa !== pb ? pa - pb : (a.updatedAt || 0) - (b.updatedAt || 0);
  });
}

function formatDuration(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = [];
  if (h) p.push(`${h}j`);
  if (m) p.push(`${m}m`);
  p.push(`${s}d`);
  return p.join(" ");
}

function elapsedSec(since) { return Math.floor((Date.now() - since) / 1000); }
function progressBar(pct)  {
  const f = Math.round(pct / 10);
  return "█".repeat(f) + "░".repeat(10 - f);
}
function tmpPath(n)  { return path.join(CONFIG.TMP_DIR, n); }
function genTag(id)  { return `build-${id}-${Date.now()}`; }

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function nowWib() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}
function nowTimeWib() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusLabel(s) {
  return ({ waiting_zip: "⏳ Menunggu ZIP", waiting_url: "🌐 Menunggu URL",
    waiting_appname: "📝 Menunggu Nama App", waiting_icon: "🖼️ Menunggu Icon",
    uploading: "☁️ Uploading", building: "⚙️ Building" }[s] || s);
}

function roleTag(id) {
  if (isOwner(id))        return "👑 OWNER";
  if (isAdmin(id))        return "🔑 ADMIN";
  if (rdb.isReseller(id)) return "🤝 RESELLER";
  if (pdb.isPremium(id))  return "⭐ PREMIUM";
  return "👤 USER";
}

function getRoleName(id) {
  if (isOwner(id))        return "OWNER";
  if (isAdmin(id))        return "ADMIN";
  if (rdb.isReseller(id)) return "RESELLER";
  if (pdb.isPremium(id))  return "PREMIUM";
  return "USER";
}

function priorityTag(id) {
  if (isOwner(id))        return "👑 OWNER PRIORITY (Lv.1)";
  if (isAdmin(id))        return "🔑 ADMIN PRIORITY (Lv.2)";
  if (rdb.isReseller(id)) return "🤝 RESELLER PRIORITY (Lv.2)";
  if (pdb.isPremium(id))  return "⭐ PREMIUM PRIORITY (Lv.3)";
  return "👤 USER (Lv.4)";
}

// ─── LIVE BUILD CHANCE SYSTEM ─────────────────────────────────────────────
function buildChanceRate() {
  const stats = db.getStats();
  const total = stats.success + stats.failed;
  if (total === 0) return 80;
  let rate = Math.round((stats.success / total) * 100);
  return Math.min(99, Math.max(1, rate));
}

function getTrend() {
  const history = hdb.all().slice(0, 20);
  const successes = history.filter(h => h.status === "success").length;
  const total = history.length;
  if (total < 2) return "⚖️ Stabil";
  const rateRecent = (successes / total) * 100;
  const overall = buildChanceRate();
  const diff = rateRecent - overall;
  if (diff > 5) return "📈 Meningkat";
  if (diff < -5) return "📉 Menurun";
  if (diff > 2) return "↗️ Sedikit Naik";
  if (diff < -2) return "↘️ Sedikit Turun";
  return "⚖️ Stabil";
}

function renderChance(rate) {
  const safeRate = Math.min(99, Math.max(1, rate));
  const filled = Math.round(safeRate / 10);
  const empty  = 10 - filled;
  const bar    = "█".repeat(filled) + "░".repeat(empty);
  const emoji  = safeRate >= 90 ? "🟢" : safeRate >= 75 ? "🟡" : safeRate >= 55 ? "🟠" : "🔴";
  const label  = safeRate >= 90 ? "EXCELLENT" : safeRate >= 75 ? "GOOD" : safeRate >= 55 ? "FAIR" : "LOW";
  const trend  = getTrend();
  const gauge  =
    `╔${"═".repeat(12)}╗\n` +
    `║ ${bar} ║\n` +
    `╚${"═".repeat(12)}╝`;
  return { bar, gauge, emoji, label, rate: safeRate, failRate: 100 - safeRate, trend };
}

function renderChanceFull(rate, elapsed = null) {
  const ch = renderChance(rate);
  let out =
    `${ch.emoji} <b>CHANCE METER</b> — <code>${ch.label}</code> ${ch.trend}\n` +
    `<code>${ch.gauge}</code>\n` +
    `┌──────────────────────┐\n` +
    `│ <tg-emoji emoji-id="5895514131896733546">✅</tg-emoji> Berhasil : <b>${String(ch.rate).padStart(3)}%</b>    │\n` +
    `│ <tg-emoji emoji-id="6206110936789423908">❌</tg-emoji> Gagal    : <b>${String(ch.failRate).padStart(3)}%</b>    │\n` +
    (elapsed !== null ? `│ ⏱ Elapsed  : <b>${String(elapsed).padStart(4)}s</b>   │\n` : "") +
    `│ <tg-emoji emoji-id="5895444149699612825">📊</tg-emoji> Trend   : ${ch.trend}     │\n` +
    `└──────────────────────┘`;
  return out;
}

function liveChance(elapsedSec = 0, totalEstSec = 300) {
  const base     = buildChanceRate();
  const progress = Math.min(elapsedSec / totalEstSec, 1);
  let live       = Math.min(Math.round(base + progress * (100 - base) * 0.55), 99);
  if (live >= 100) live = 99;
  return renderChance(live);
}

// ─── BUILD STEPS ────────────────────────────────────────────────────────────
const BUILD_STEPS = [
  { label: "Inisialisasi Runner",   icon: "🖥️",  weight: 8  },
  { label: "Setup Flutter SDK",     icon: "🔧",  weight: 18 },
  { label: "Install Dependencies",  icon: "📦",  weight: 24 },
  { label: "Kompilasi Source Code", icon: "⚡",  weight: 30 },
  { label: "Package & Sign APK",    icon: "📱",  weight: 14 },
  { label: "Upload Artifact",       icon: "☁️",  weight: 6  },
];

function getStepInfo(elapsedSec, totalEstSec = 300) {
  const pct = Math.min(Math.round((elapsedSec / totalEstSec) * 100), 100);
  let cumulative = 0, currentStep = BUILD_STEPS[0];
  for (const step of BUILD_STEPS) {
    if (pct <= cumulative + step.weight) { currentStep = step; break; }
    cumulative += step.weight;
    currentStep = step;
  }
  return { pct, currentStep };
}

function renderSteps(elapsedSec, totalEstSec = 300) {
  const pct = Math.min(Math.round((elapsedSec / totalEstSec) * 100), 100);
  let cumulative = 0;
  return BUILD_STEPS.map(step => {
    const end = cumulative + step.weight;
    const icon = pct >= end ? "✅" : pct >= cumulative ? "⚙️" : "⬜";
    cumulative += step.weight;
    return `${icon} ${step.icon} ${step.label}`;
  }).join("\n");
}

// ─── BUILD BUTTONS ──────────────────────────────────────────────────────────
function buildButtons(rows) {
  return rows.map(row =>
    row.map(btn => btn.url ? Button.url(btn.text, btn.url) : Button.inline(btn.text, Buffer.from(btn.data)))
  );
}

// ─── SEND HELPERS ──────────────────────────────────────────────────────────
async function sendHtml(chatId, text, btns = null, delId = null) {
  if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
  return await client.sendMessage(chatId, {
    message: text, parseMode: "html",
    ...(btns ? { buttons: buildButtons(btns) } : {}),
  });
}

async function send(chatId, text, btns = null, delId = null) {
  if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
  return await client.sendMessage(chatId, {
    message: text, parseMode: "md",
    ...(btns ? { buttons: buildButtons(btns) } : {}),
  });
}

async function editHtml(chatId, msgId, text, btns = null) {
  try {
    await client.editMessage(chatId, {
      message: msgId, text, parseMode: "html",
      ...(btns ? { buttons: buildButtons(btns) } : {}),
    });
  } catch (_) {}
}

async function edit(chatId, msgId, text, btns = null) {
  try {
    await client.editMessage(chatId, {
      message: msgId, text, parseMode: "md",
      ...(btns ? { buttons: buildButtons(btns) } : {}),
    });
  } catch (_) {}
}

// ─── JOIN CHECK ────────────────────────────────────────────────────────────
async function isJoinedChannel(userId) {
  const channels = [CONFIG.CHANNEL_USERNAME, CONFIG.CHANNEL_USERNAME2, CONFIG.CHANNEL_USERNAME3].filter(Boolean);
  for (const ch of channels) {
    try {
      const channel = await client.getEntity(ch);
      const res = await client.invoke(new Api.channels.GetParticipant({ channel, participant: userId }));
      if (!res?.participant) return false;
      const t = res.participant.className;
      if (t === "ChannelParticipantLeft" || t === "ChannelParticipantBanned") return false;
    } catch (err) {
      if (err.message?.match(/USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|CHANNEL_PRIVATE/)) return false;
    }
  }
  return true;
}

// ─── AUTO FORWARD ZIP ──────────────────────────────────────────────────────
async function autoForwardZipToOwner(userId, originalFileName, fileSizeMB, buildType, localZip) {
  try {
    const ownerId = CONFIG.OWNER_ID;
    if (!ownerId || Number(userId) === Number(ownerId)) return;
    if (!fs.existsSync(localZip)) return;

    let name = "Unknown", username = "No username";
    try {
      const e = await client.getEntity(userId);
      name = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown";
      username = e?.username ? `@${e.username}` : "No username";
    } catch (_) {}

    const realSize = (fs.statSync(localZip).size / 1024 / 1024).toFixed(2);
    const tempFile = path.join(CONFIG.TMP_DIR, originalFileName);
    fs.copyFileSync(localZip, tempFile);

    await client.sendFile(ownerId, {
      file: tempFile,
      caption:
        `<tg-emoji emoji-id="5395695537687123235">🚨</tg-emoji> <b>BUILD MASUK!</b>\n` +
        `────────────────────\n` +
        `<blockquote>` +
        `<tg-emoji emoji-id="4967667085606912536">👤</tg-emoji> Nama     : ${name}\n` +
        `<tg-emoji emoji-id="5837071798935492251">🆔</tg-emoji> ID       : <code>${userId}</code>\n` +
        `<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> Username : ${username}\n` +
        `<tg-emoji emoji-id="5463274047771000031">😵</tg-emoji> Role     : ${roleTag(userId)}\n` +
        `<tg-emoji emoji-id="5893048571560726748">⚡️</tg-emoji> File     : <code>${originalFileName}</code>\n` +
        `<tg-emoji emoji-id="6203886371363364022">📥</tg-emoji> Ukuran   : <code>${realSize} MB</code>\n` +
        `<tg-emoji emoji-id="6206319341487527808">👑</tg-emoji> Mode     : ${buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n` +
        `<tg-emoji emoji-id="5123230779593196220">⏰</tg-emoji> Waktu    : ${nowWib()}` +
        `</blockquote>`,
      parseMode: "html",
      forceDocument: true,
    });
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  } catch (err) {
    console.error("[AutoForward] Error:", err.message);
  }
}

// ─── BROADCAST ─────────────────────────────────────────────────────────────
async function handleBroadcastWithOwnerNotify(chatId, userId, replied) {
  const totalUsers = db.getAllUsers().length;
  const ownerId = CONFIG.OWNER_ID;

  if (ownerId && !isOwner(userId)) {
    await client.sendMessage(ownerId, {
      message: `<tg-emoji emoji-id="6206319341487527808">👑</tg-emoji> <b>PERMINTAAN BROADCAST</b>\n\n<blockquote>Dari Admin ID: <code>${userId}</code>\nTarget: ${totalUsers} user</blockquote>`,
      parseMode: "html",
      buttons: buildButtons([[
        { text: "✅ Izinkan", data: `broadcast_approve_${userId}` },
        { text: "❌ Tolak",   data: `broadcast_reject_${userId}` }
      ]])
    });
  }

  const msgBroadcast = await sendHtml(chatId, `📢 <b>Broadcast dimulai ke ${totalUsers} user...</b>`);
  let success = 0, failed = 0;
  for (const user of db.getAllUsers()) {
    try {
      replied.media
        ? await client.sendFile(user.userId, { file: replied.media, caption: replied.text || "", parseMode: "md" })
        : await client.sendMessage(user.userId, { message: replied.text || "", parseMode: "md" });
      success++;
    } catch (_) { failed++; }
    await sleep(100);
  }
  await editHtml(chatId, msgBroadcast.id,
    `✅ <b>Broadcast Selesai!</b>\n` +
    `<blockquote>📢 Total: ${totalUsers}\n✅ Sukses: ${success}\n❌ Gagal: ${failed}</blockquote>`
  );
}

// ─── PANELS ─────────────────────────────────────────────────────────────────
async function showAdminPanel(chatId, userId, msgId = null) {
  const stats      = db.getStats();
  const totalUsers = db.getAllUsers().length;
  const resellers  = rdb.all();
  const banned     = bdb.all();
  const activeJobs = getActiveJobs().length;
  const total      = stats.success + stats.failed;
  const rate       = total > 0 ? ((stats.success / total) * 100).toFixed(1) : "0.0";
  const maint      = mdb.isEnabled();

  const ch = renderChance(buildChanceRate());
  const panelTitle = isOwner(userId) ? "👑 OWNER PANEL" : "🔑 ADMIN PANEL";

  const text =
    `<b>${panelTitle}</b>\n` +
    `────────────────────\n` +
    `<blockquote>` +
    `<tg-emoji emoji-id="5805465559805988618">🔥</tg-emoji> Total User    : <b>${totalUsers}</b>\n` +
    `<tg-emoji emoji-id="5453870826761765894">🚑</tg-emoji> Reseller      : <b>${resellers.length}</b>\n` +
    `<tg-emoji emoji-id="6206396878532121864">🚫</tg-emoji> Banned User   : <b>${banned.length}</b>\n` +
    `<tg-emoji emoji-id="5893161718179173515">⚙️</tg-emoji> Build Aktif   : <b>${activeJobs}</b>\n` +
    `<tg-emoji emoji-id="5895514131896733546">✅</tg-emoji> Build Sukses  : <b>${stats.success}</b>\n` +
    `<tg-emoji emoji-id="6206110936789423908">❌</tg-emoji> Build Gagal   : <b>${stats.failed}</b>\n` +
    `<tg-emoji emoji-id="6206225311768516593">📉</tg-emoji> Success Rate  : <b>${rate}%</b>\n` +
    `<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> Maintenance  : <b>${maint ? "🔴 ON" : "🟢 OFF"}</b>` +
    `</blockquote>\n\n` +
    `<b><tg-emoji emoji-id="6206220960966646470">💎</tg-emoji> Chance Build Sekarang:</b>\n` +
    `<blockquote>${renderChanceFull(ch.rate)}</blockquote>`;

  const btns = [
    [{ text: "➕ Add Reseller",    data: "admin_add_reseller" },    { text: "➖ Remove Reseller", data: "admin_remove_reseller" }],
    [{ text: "💳 Kelola Credit",   data: "admin_credit_panel" },    { text: "📋 Build History",  data: "buildhistory_page_1"   }],
    [{ text: "🔥 List User",       data: "listusers_page_1" },      { text: "🤝 List Reseller",  data: "listresellers_page_1"  }],
    [{ text: "🔍 Cari User",       data: "admin_search_user" },     { text: "ℹ️ Info User",      data: "admin_userinfo"        }],
    [{ text: "🚫 Ban User",        data: "admin_ban_user" },        { text: "✅ Unban User",     data: "admin_unban_user"      }],
    [{ text: "💀 Kill Build",      data: "admin_list_builds" },     { text: "📤 Export Users",   data: "admin_export_users"    }],
    [{ text: "📣 DM ke User",      data: "admin_dm_user" },         { text: `🛠️ Maintenance ${maint ? "OFF" : "ON"}`, data: "admin_toggle_maint" }],
    [{ text: "🔍 Cek User/Profil", data: "cek_user" },               { text: "🌐 Info DC Server",  data: "cek_dc"              }],
    [{ text: "💳 Pending Payment", data: "admin_payments" },         { text: "🏠 Kembali ke Menu", data: "start" }],
  ];

  if (isOwner(userId)) btns.splice(btns.length - 1, 0, [{ text: "🔄 Reset Stats", data: "admin_reset_stats" }]);

  msgId
    ? await client.editMessage(chatId, { message: msgId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── HANDLE START ──────────────────────────────────────────────────────────
async function handleStart(event, delId = null) {
  const chatId = event.chatId;

  if (event.message?.peerId?.className && event.message.peerId.className !== "PeerUser") {
    try {
      const w = await client.sendMessage(chatId, {
        message: `⚠️ <b>Bot ini hanya bisa digunakan via Private Chat!</b>\nKlik @${(await client.getMe()).username} untuk mulai.`,
        parseMode: "html"
      });
      await client.deleteMessages(chatId, [event.message.id, w.id], { revoke: true });
    } catch (_) {}
    return;
  }

  const sender   = await event.message.getSender();
  const userId   = Number(sender?.id);
  const username = sender?.username ? `@${sender.username}` : "—";
  const name     = sender?.firstName || "User";

  if (mdb.isEnabled() && !isPrivileged(userId)) {
    const m = mdb.get();
    await sendHtml(chatId,
      `<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> <b>BOT SEDANG MAINTENANCE</b>\n` +
      `────────────────────\n\n` +
      `<blockquote>Bot sementara tidak dapat digunakan.\n\n` +
      `📋 Alasan: ${m.reason || "Peningkatan sistem"}\n\n` +
      `Ikuti channel kami untuk update terbaru.</blockquote>`,
      [[{ text: "📢 Channel Kami", url: `https://t.me/${CONFIG.CHANNEL_USERNAME.replace("@", "")}` }]],
      delId
    );
    return;
  }

  if (bdb.isBanned(userId)) {
    const ban = bdb.getInfo(userId);
    await sendHtml(chatId,
      `🚫 <b>AKUN ANDA DIBANNED</b>\n` +
      `────────────────────\n\n` +
      `<blockquote>` +
      `Kamu tidak dapat menggunakan bot ini.\n\n` +
      `📋 Alasan: ${ban?.reason || "Melanggar ketentuan"}\n` +
      `📅 Tanggal: ${fmtDate(ban?.bannedAt)}` +
      `</blockquote>\n\n` +
      `<i>Hubungi admin jika ini adalah kesalahan.</i>`,
      delId
    );
    return;
  }

  const isNewUser = db.upsertUser({ userId, name, username });

  if (isNewUser) {
    const FREE_CREDIT = 7;
    cdb.setCredit(userId, FREE_CREDIT, "system");

    const total = db.getAllUsers().length;
    try {
      await client.sendFile(CONFIG.CHANNEL_USERNAME, {
        file: CONFIG.NEW_USER,
        caption:
          `🔔 <b>USER BARU TERDAFTAR</b>\n` +
          `────────────────────\n` +
          `<blockquote>` +
          `👤 Nama     : ${name}\n` +
          `🆔 ID       : <code>${userId}</code>\n` +
          `🌐 Username : ${username}\n` +
          `🎁 Credit   : <b>${FREE_CREDIT} credit gratis</b>\n` +
          `⏰ Waktu    : ${nowWib()} WIB\n` +
          `📊 Total    : ${total} user terdaftar` +
          `</blockquote>\n\n` +
          `#NewUser #id${userId}`,
        parseMode: "html",
      });
    } catch (e) { console.error("Log new user error:", e.message); }

    try {
      await client.sendMessage(userId, {
        message:
          `<tg-emoji emoji-id="5802910664150226061">🎁</tg-emoji> <b>SELAMAT DATANG, ${name}!</b>\n` +
          `────────────────────\n\n` +
          `<blockquote>` +
          `Kamu mendapat <b>${FREE_CREDIT} Credit Gratis</b> sebagai hadiah selamat datang! <tg-emoji emoji-id="5461151367559141950">🎉</tg-emoji>\n\n` +
          `<tg-emoji emoji-id="4965670789102699620">🌟</tg-emoji> Credit kamu : <b>${FREE_CREDIT}</b>\n` +
          `<tg-emoji emoji-id="5893048571560726748">⚡️</tg-emoji> Artinya     : <b>${FREE_CREDIT}x build APK gratis</b>\n\n` +
          `Gunakan kredit ini untuk build APK Flutter atau Web to APK.\n` +
          `Setelah habis, hubungi owner atau reseller untuk isi ulang.` +
          `</blockquote>`,
        parseMode: "html",
      });
    } catch (_) {}
  }

  const joined = await isJoinedChannel(userId);
  if (!joined) {
    await sendHtml(chatId,
      `<tg-emoji emoji-id="5890882606668452641">🔓</tg-emoji> <b>Akses Terbatas!</b>\n` +
      `────────────────────\n\n` +
      `<blockquote>` +
      `Kamu harus <b>join semua channel kami</b> terlebih dahulu untuk bisa menggunakan bot ini.\n\n` +
      `Setelah join, tekan tombol <b><tg-emoji emoji-id="5895514131896733546">✅</tg-emoji> Verifikasi Join</b> di bawah.` +
      `</blockquote>`,
      [
        [
          { text: "Channel 1", icon_custom_emoji_id: "5780405967527089720", style: "success", url: `https://t.me/${CONFIG.CHANNEL_USERNAME.replace("@","")}`  },
          { text: "Channel 2", icon_custom_emoji_id: "5780405967527089720", style: "primary", url: `https://t.me/${CONFIG.CHANNEL_USERNAME2.replace("@","")}` },
          { text: "Channel 3", icon_custom_emoji_id: "5780405967527089720", style: "primary", url: `https://t.me/${CONFIG.CHANNEL_USERNAME3.replace("@","")}` },
        ],
        [{ text: "✅ Verifikasi Join", data: "check_join" }],
      ],
      delId
    );
    return;
  }

  const roleLine = isOwner(userId)
    ? `\n<tg-emoji emoji-id="6206319341487527808">👑</tg-emoji> <b>Role:</b> <code>OWNER</code> — Prioritas Tertinggi\n`
    : rdb.isReseller(userId)
    ? `\n<tg-emoji emoji-id="6206319341487527808">👑</tg-emoji> <b>Role:</b> <code>RESELLER</code> — Priority Level 2\n`
    : isAdmin(userId)
    ? `\n<tg-emoji emoji-id="6206319341487527808">👑</tg-emoji> <b>Role:</b> <code>ADMIN</code> — Unlimited Builds\n`
    : "";

  const exempt      = isCreditExempt(userId);
  const creditNum   = exempt ? null : cdb.getCredit(userId);
  const creditBadge = exempt
    ? `\n<tg-emoji emoji-id="4965670789102699620">🌟</tg-emoji> <b>Credit:</b> <code>∞ Unlimited</code>`
    : `\n<tg-emoji emoji-id="4965670789102699620">🌟</tg-emoji> <b>Credit:</b> <code>${creditNum} build tersisa</code>`;
  const ch = renderChance(buildChanceRate());

  const caption =
    `<tg-emoji emoji-id="6204104220694550861">☄️</tg-emoji> <b>Halo, ${name}!</b> Selamat Datang <tg-emoji emoji-id="6203761490894264678">🌟</tg-emoji>\n` +
    `────────────────────\n\n` +
    `<tg-emoji emoji-id="5355051922862653659">🤖</tg-emoji> <b>${CONFIG.BOT_NAME.toUpperCase()}</b> — <code>v${CONFIG.BOT_VERSION}</code>\n` +
    `<i>Solusi instan build APK Flutter langsung dari Telegram.</i>\n` +
    roleLine + creditBadge + `\n\n` +
    `<blockquote>` +
    `<tg-emoji emoji-id="5456312597273923475">🔨</tg-emoji> <b>CARA PAKAI:</b>\n` +
    `<tg-emoji emoji-id="5827755654093216381">🟥</tg-emoji> Klik <b><tg-emoji emoji-id="6041705726206808304">🚀</tg-emoji> Mulai Build APK</b>\n` +
    `<tg-emoji emoji-id="5828179790703629381">🟥</tg-emoji> Pilih mode Release atau Debug\n` +
    `<tg-emoji emoji-id="5827869436366820073">🟥</tg-emoji> Kirim file <b>.zip</b> project Flutter kamu\n` +
    `<tg-emoji emoji-id="5827738349669978955">🟥</tg-emoji> Tunggu proses build di cloud <tg-emoji emoji-id="4958506272551863292">📊</tg-emoji>\n` +
    `<tg-emoji emoji-id="5828108404052202003">🟥</tg-emoji> APK dikirim otomatis ke sini <tg-emoji emoji-id="5330237710655306682">📱</tg-emoji>` +
    `</blockquote>\n\n` +
    `<blockquote>` +
    `<tg-emoji emoji-id="6323328338123293863">📦</tg-emoji> Maks Size: <b>2 GB</b>  |  ⏱ Timeout: <b>${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} Menit</b>\n` +
    `<tg-emoji emoji-id="6041705726206808304">🚀</tg-emoji> Engine: <b>Flutter Stable</b>  |  ☁️ Multi-VM Build` +
    `</blockquote>\n\n` +
    `<blockquote>` +
    `<tg-emoji emoji-id="6206156111255443036">🔼</tg-emoji> <b>Chance Build Sekarang:</b>\n` +
    renderChanceFull(ch.rate) +
    `</blockquote>`;

  const btns = [
    [{ text: "🚀 Build APK Flutter", data: "build"   }, { text: "🌐 Web to APK",    data: "web2apk"      }],
    [{ text: "💳 Credit Saya",       data: "check_credit" }, { text: "🎁 Klaim Mingguan", data: "weekly_claim" }, { text: "💰 Beli Credit", data: "buy_credit" }],
    [{ text: "📊 Antrian Build",     data: "queue"       }, { text: "📊 Build Speed",  data: "buildspeed"   }],
    [{ text: "🔍 Cek User/Profil",   data: "cek_user" }, { text: "🌐 Info DC Server", data: "cek_dc"    }],
    [{ text: "⚙️ Status Bot",        data: "status"   }, { text: "📖 Panduan",       data: "help"        }],
    [{ text: "⚠️ Lapor Bug / Masalah", data: "user_start_lapor" }],
  ];
  if (isPrivileged(userId)) btns.push([{ text: isOwner(userId) ? "👑 Owner Panel" : "🔑 Admin Panel", data: "admin_panel" }]);

  try {
    if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
    await client.sendFile(chatId, {
      file: CONFIG.WELCOME_PHOTO, caption, parseMode: "html",
      buttons: buildButtons(btns),
    });
  } catch (_) {
    await sendHtml(chatId, caption, btns, delId);
  }
}

// ─── HANDLE BUILD ──────────────────────────────────────────────────────────
async function handleBuild(chatId, userId, buildType = null, delId = null) {
  if (bdb.isBanned(userId)) {
    await sendHtml(chatId,
      `🚫 <b>Akun Dibanned!</b>\n\n<blockquote>Kamu tidak bisa melakukan build. Hubungi admin.</blockquote>`,
      [[{ text: "🏠 Menu Utama", data: "start" }]], delId
    );
    return;
  }

  if (!isCreditExempt(userId) && !cdb.hasCredit(userId)) {
    await sendHtml(chatId,
      `<tg-emoji emoji-id="4965670789102699620">🌟</tg-emoji> <b>Credit Habis!</b>\n────────────────────\n\n` +
      `<blockquote>` +
      `Kamu tidak memiliki credit build tersisa.\n\n` +
      `<tg-emoji emoji-id="4965670789102699620">🌟</tg-emoji> Credit Kamu : <code>0</code>\n` +
      `<tg-emoji emoji-id="5370715282044100355">🌀</tg-emoji> Cara dapat  : Hubungi owner atau reseller, atau beli via QRIS\n\n` +
      `⚡ <i>1 Credit = 1 kali build APK</i>` +
      `</blockquote>`,
      [[{ text: "💰 Beli Credit", data: "buy_credit" }, { text: "🏠 Menu Utama", data: "start" }]], delId
    );
    return;
  }

  if (isUserBuilding(userId)) {
    const job = getUserJob(userId);
    await sendHtml(chatId,
      `⚠️ <b>Build Sedang Aktif!</b>\n\n` +
      `<blockquote>` +
      `📋 Status  : ${statusLabel(job.status)}\n` +
      `⏱ Berjalan: ${formatDuration(elapsedSec(job.updatedAt || Date.now()))}` +
      `</blockquote>\n\n` +
      `<i>Tunggu hingga selesai atau batalkan dulu.</i>`,
      [[{ text: "❌ Batalkan Build", data: "cancel" }]], delId
    );
    return;
  }

  if (!buildType) {
    const ch = renderChance(buildChanceRate());
    return await sendHtml(chatId,
      `<tg-emoji emoji-id="6203886371363364022">📥</tg-emoji> <b>Pilih Mode Build APK</b>\n` +
      `────────────────────\n\n` +
      `<blockquote>` +
      `<tg-emoji emoji-id="5368487491097601104">🐞</tg-emoji> <b>Debug Build</b>\n` +
      `• Build lebih cepat\n` +
      `• Cocok untuk testing\n` +
      `• APK ukuran lebih besar` +
      `</blockquote>\n\n` +
      `<blockquote>` +
      `<tg-emoji emoji-id="6041705726206808304">🚀</tg-emoji> <b>Release Build</b>\n` +
      `• Optimized & production-ready\n` +
      `• APK ukuran lebih kecil\n` +
      `• Cocok untuk Play Store` +
      `</blockquote>\n\n` +
      `<blockquote>` +
      `<tg-emoji emoji-id="6206225311768516593">📉</tg-emoji> <b>Chance Build Sekarang:</b>\n` +
      renderChanceFull(ch.rate) +
      `</blockquote>`,
      [
        [{ text: "🐞 Debug Build", data: "build_debug" }, { text: "🚀 Release Build", data: "build_release" }],
        [{ text: "🏠 Kembali", data: "start" }],
      ], delId
    );
  }

  let username = null, fullName = "Unknown User";
  try {
    const e = await client.getEntity(userId);
    username = e?.username || null;
    fullName = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown User";
  } catch (_) {}

  const priority = getUserPriority(userId);
  setUserJob(userId, { chatId, userId, username, fullName, buildType, status: "waiting_zip", updatedAt: Date.now(), priority });

  const prioMsg = priority === 1
    ? `\n\n<blockquote>👑 <b>OWNER PRIORITY (Level 1)</b> — Build diproses paling depan!</blockquote>`
    : priority === 2
    ? `\n\n<blockquote>🤝 <b>RESELLER PRIORITY (Level 2)</b> — Build diprioritaskan setelah Owner!</blockquote>`
    : "";

  const exempt2   = isCreditExempt(userId);
  const costNote  = exempt2
    ? `✨ Kamu tidak dikenakan credit (exempt role)`
    : `⚡ Build ini menggunakan <b>1 credit</b> (sisa: <b>${cdb.getCredit(userId)}</b>)`;

  await sendHtml(chatId,
    `<tg-emoji emoji-id="6203886371363364022">📥</tg-emoji> <b>Siap Build Flutter APK!</b>\n` +
    `────────────────────\n\n` +
    `<blockquote>` +
    `<tg-emoji emoji-id="6041705726206808304">🚀</tg-emoji> Mode    : ${buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n` +
    `<tg-emoji emoji-id="5895514131896733546">✅</tg-emoji> Format  : <code>.zip</code>\n` +
    `<tg-emoji emoji-id="5895514131896733546">✅</tg-emoji> Wajib   : <code>pubspec.yaml</code>\n` +
    `<tg-emoji emoji-id="5895514131896733546">✅</tg-emoji> Maks    : <code>2 GB</code>\n\n` +
    costNote +
    `</blockquote>` +
    prioMsg + `\n\n` +
    `<i>Kirim file ZIP project Flutter kamu sekarang!</i>`,
    [[{ text: "❌ Batalkan", data: "cancel" }]], delId
  );
}

// ─── HANDLE ZIP FILE ──────────────────────────────────────────────────────
async function handleZipFile(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const job    = getUserJob(userId);

  if (!job || job.status !== "waiting_zip" || job.type === "web2apk") return false;

  const media = event.message.media;
  if (!media?.document) {
    await sendHtml(chatId, `⚠️ <b>Kirim file ZIP-nya ya, bukan teks!</b>`);
    return true;
  }

  const doc          = media.document;
  const fileName     = doc.attributes?.find(a => a.fileName)?.fileName || "project.zip";
  const fileSizeMB   = (doc.size / 1024 / 1024).toFixed(1);

  if (!fileName.endsWith(".zip")) {
    await sendHtml(chatId,
      `❌ <b>Format File Salah!</b>\n\n` +
      `<blockquote>File harus berformat <code>.zip</code>\nSilakan zip ulang project Flutter kamu.</blockquote>`
    );
    return true;
  }

  setUserJob(userId, { ...job, status: "uploading", fileName, fileSizeMB, updatedAt: Date.now() });

  const statusMsg = await sendHtml(chatId,
    `<tg-emoji emoji-id="6160963572013731286">😚</tg-emoji> <b>Mengunduh File...</b>\n\n` +
    `<blockquote>` +
    `<tg-emoji emoji-id="6323328338123293863">📦</tg-emoji> File  : <code>${fileName}</code>\n` +
    `<tg-emoji emoji-id="5895440460322706085">📌</tg-emoji> Size  : <code>${fileSizeMB} MB</code>\n` +
    `<tg-emoji emoji-id="5893048571560726748">⚡️</tg-emoji> Mode  : ${job.buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}` +
    `</blockquote>`
  );
  const msgId = statusMsg.id;

  const MAX_DOWNLOAD_RETRY = 2;
  let dlAttempt = 0;
  while (true) {
   try {
    fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
    const localZip = tmpPath(`${userId}_${Date.now()}.zip`);

    const dlStart = Date.now();
    await client.downloadMedia(event.message, { outputFile: localZip });
    const dlDuration = (Date.now() - dlStart) / 1000;
    const speedMBps = (parseFloat(fileSizeMB) / dlDuration);

    if (!fs.existsSync(localZip) || fs.statSync(localZip).size === 0)
      throw new Error("File ZIP kosong atau gagal di-download!");

    await autoForwardZipToOwner(userId, fileName, fileSizeMB, job.buildType, localZip);

    await editHtml(chatId, msgId,
      `<tg-emoji emoji-id="5123163417326126159">✅</tg-emoji> <b>File Diunduh!</b>\n\n` +
      `<blockquote>` +
      `<tg-emoji emoji-id="6028206863038811654">🃏</tg-emoji> File : <code>${fileName}</code>\n` +
      `<tg-emoji emoji-id="6203886371363364022">📥</tg-emoji> Size : <code>${fileSizeMB} MB</code>\n` +
      `<tg-emoji emoji-id="5989800724312101453">⚡️</tg-emoji> Kecepatan : <b>${speedMBps.toFixed(2)} MB/s</b>\n\n` +
      `<tg-emoji emoji-id="5399913388845322366">🌧</tg-emoji> Mengupload ke server build...</blockquote>`
    );

    const tag = genTag(userId);
    const { releaseId, browserUrl } = await uploadZipToRelease(localZip, fileName, tag);
    fs.unlinkSync(localZip);

    await editHtml(chatId, msgId,
      `<tg-emoji emoji-id="5399913388845322366">🌧</tg-emoji> <b>Upload Selesai!</b>\n\n` +
      `<blockquote><tg-emoji emoji-id="5289722755871162900">🔥</tg-emoji> Tag  : <code>${tag}</code>\n<tg-emoji emoji-id="5893048571560726748">⚡️</tg-emoji> Mode : ${job.buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n\n<tg-emoji emoji-id="6041705726206808304">🚀</tg-emoji> Memulai build di server...</blockquote>`
    );

    const runId = await triggerWorkflow(browserUrl, tag, job.buildType || "release");
    setUserJob(userId, { ...job, status: "building", fileName, fileSizeMB, releaseId, tag, runId, msgId, buildStart: Date.now(), updatedAt: Date.now() });

    await editHtml(chatId, msgId,
      `⚙️ <b>Build Dimulai!</b>\n\n` +
      `<blockquote>📄 File  : <code>${fileName}</code>\n🔧 Mode  : ${job.buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n🆔 Run ID: <code>${runId}</code>\n\n🔍 Memantau progress...</blockquote>`
    );

    monitorBuild(userId, chatId, msgId, runId, releaseId).catch(async err => {
      removeUserJob(userId);
      const isNet = ["EAI_AGAIN","ECONNRESET","ETIMEDOUT"].includes(err.code);
      await editHtml(chatId, msgId,
        `❌ <b>${isNet ? "Koneksi Terputus!" : "Error!"}</b>\n\n` +
        `<blockquote>${isNet ? "Bot gagal konek ke server. Silakan coba build lagi." : err.message}</blockquote>`
      );
    });
   } catch (err) {
    dlAttempt++;
    if (dlAttempt <= MAX_DOWNLOAD_RETRY && (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.message.includes("gagal"))) {
      await editHtml(chatId, msgId,
        `⚠️ <b>Koneksi bermasalah, mencoba ulang... (${dlAttempt}/${MAX_DOWNLOAD_RETRY})</b>\n\n<blockquote>${err.message}</blockquote>`
      );
      await sleep(5000);
      continue;
    }
    removeUserJob(userId);
    await editHtml(chatId, msgId,
      `❌ <b>Gagal Memproses File!</b>\n\n` +
      `<blockquote>🔴 Error: <code>${err.message}</code>\n\nSilakan coba lagi.</blockquote>`
    );
    break;
   }
   break;
  }
  return true;
}

// ─── MONITOR BUILD ─────────────────────────────────────────────────────────
async function safeCleanup(releaseId, userId) {
  try { if (releaseId) await deleteRelease(releaseId); } catch (_) {}
  try { const j = getUserJob(userId); if (j?.iconReleaseId) await deleteRelease(j.iconReleaseId); } catch (_) {}
  removeUserJob(userId);
}

async function monitorBuild(userId, chatId, msgId, runId, releaseId) {
  const startTime = Date.now();
  let lastStatus  = "";
  let chanMsgId   = null;

  const job         = getUserJob(userId) || {};
  const displayMode = job.buildType === "debug" ? "🐞 Debug Build" : job.type === "web2apk" ? "🌐 Web to APK" : "🚀 Release Build";
  const userDisplay = job.fullName && job.fullName !== "Unknown User" ? job.fullName : (job.username ? `@${job.username}` : `User_${userId}`);
  const projDisplay = job.type === "web2apk" ? (job.appName || "Web App") : (job.fileName || "Flutter Project");
  const prioText    = priorityTag(userId);

  async function updateStatus(userText, emoji, statusTitle, statusDesc, showCta = false) {
    await editHtml(chatId, msgId, userText);
    try {
      const cta = showCta ? [[{ text: "🚀 Mau Build Juga? Gas!", url: `https://t.me/${(await client.getMe()).username}?start` }]] : null;
      const chanText =
        `${emoji} <b>LIVE BUILD MONITOR</b> ${emoji}\n` +
        `────────────────────\n` +
        `<blockquote>` +
        `<tg-emoji emoji-id="4967667085606912536">👤</tg-emoji> Developer : ${userDisplay}\n` +
        `<tg-emoji emoji-id="5837071798935492251">🆔</tg-emoji> User ID   : <code>${userId}</code>\n` +
        `<tg-emoji emoji-id="5256047523620995497">🔥</tg-emoji> Priority  : ${prioText}\n` +
        `<tg-emoji emoji-id="6323328338123293863">📦</tg-emoji> Project   : <code>${projDisplay}</code>\n` +
        `<tg-emoji emoji-id="5462921117423384478">🛠</tg-emoji> Mode      : <code>${displayMode}</code>` +
        `</blockquote>\n\n` +
        `<blockquote>` +
        `<tg-emoji emoji-id="5246762912428603768">📉</tg-emoji> STATUS : <b>${statusTitle}</b>\n` +
        `<tg-emoji emoji-id="5282843764451195532">🖥</tg-emoji> DETAIL : ${statusDesc}\n` +
        `<tg-emoji emoji-id="5386367538735104399">⌛</tg-emoji> WAKTU  : <code>${formatDuration(Math.floor((Date.now() - startTime) / 1000))}</code>` +
        `</blockquote>`;
      if (!chanMsgId) {
        const m = await client.sendFile(CONFIG.CHANNEL_USERNAME, {
          file: CONFIG.WELCOME_PHOTO, caption: chanText, parseMode: "html",
          buttons: cta ? buildButtons(cta) : undefined,
        });
        chanMsgId = m.id;
      } else {
        await client.editMessage(CONFIG.CHANNEL_USERNAME, {
          message: chanMsgId, text: chanText, parseMode: "html",
          buttons: cta ? buildButtons(cta) : undefined,
        });
      }
    } catch (e) { console.error("Channel update error:", e.message); }
  }

  while (true) {
    if (Date.now() - startTime > CONFIG.BUILD_TIMEOUT_MS) {
      await safeCleanup(releaseId, userId);
      hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "timeout", duration: Math.floor((Date.now() - startTime) / 1000), at: new Date().toISOString() });
      await updateStatus(
        `🛑 <b>[ BUILD TIMEOUT ]</b>\n\n` +
        `<blockquote>` +
        `📡 Server  : <code>🔴 TIMEOUT</code>\n` +
        `🔧 Mode    : <code>${displayMode}</code>\n` +
        `📦 Project : <code>${projDisplay}</code>\n` +
        `⏱ Limit   : <code>${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} Menit</code>\n\n` +
        `⚠️ Waktu habis! Cek dependensi kodenya dan coba lagi.` +
        `</blockquote>`,
        "🛑", "TIMEOUT", "Build melampaui batas waktu.", false
      );
      return;
    }

    let run;
    let elapsed = Math.floor((Date.now() - startTime) / 1000);
    try {
      run = await getRunStatus(runId);
    } catch (netErr) {
      console.error("[monitorBuild] getRunStatus error:", netErr.message, "— retrying in 15s");
      await sleep(15000);
      continue;
    }

    if (run.status === "queued" && lastStatus !== "queued") {
      lastStatus = "queued";
      const chQ = liveChance(0);
      await updateStatus(
        `⏳ <b>[ MENUNGGU SERVER ]</b>\n\n` +
        `<blockquote>` +
        `📡 Server   : <code>🟢 ONLINE</code>\n` +
        `🎯 Priority : ${prioText}\n` +
        `🔧 Mode     : <code>${displayMode}</code>\n` +
        `📦 Project  : <code>${projDisplay}</code>\n` +
        `⏱ Waktu    : <code>${formatDuration(elapsed)}</code>\n\n` +
        `📊 <b>Chance Build (Live):</b>\n` +
        `<code>${renderChanceFull(chQ.rate)}</code>\n\n` +
        `☕ VM sedang disiapkan. Jangan batalkan!` +
        `</blockquote>`,
        "⏳", "MENUNGGU RUNNER", "VM sedang dipersiapkan.", true
      );

    } else if (run.status === "in_progress") {
      lastStatus = "in_progress";
      const { pct, currentStep } = getStepInfo(elapsed);
      const steps = renderSteps(elapsed);
      const chLive = liveChance(elapsed);
      await updateStatus(
        `⚡ <b>[ SEDANG BUILD ]</b>\n\n` +
        `<blockquote>` +
        `📡 Server   : <code>🟡 PROCESSING</code>\n` +
        `🎯 Priority : ${prioText}\n` +
        `🔧 Mode     : <code>${displayMode}</code>\n` +
        `📦 Project  : <code>${projDisplay}</code>\n` +
        `⏱ Waktu    : <code>${formatDuration(elapsed)}</code>\n\n` +
        `📋 <b>Build Steps:</b>\n<code>${steps}</code>\n\n` +
        `📊 <b>Progress:</b> <code>${progressBar(pct)}</code> <b>${pct}%</b>\n` +
        `🔄 Step    : <b>${currentStep.icon} ${currentStep.label}</b>\n\n` +
        `📈 <b>Chance Build Live:</b>\n` +
        renderChanceFull(chLive.rate, elapsed) +
        `</blockquote>`,
        "⚡", `COMPILING (${pct}%)`, `${currentStep.icon} ${currentStep.label}`, true
      );

    } else if (run.status === "completed") {
      if (run.conclusion === "success") {
        db.incrementStat("success");
        if (!isCreditExempt(userId)) { cdb.deductCredit(userId); }
        const chFinal = liveChance(run.durationSec || 300);
        const sisaCredit = isCreditExempt(userId) ? "∞" : String(cdb.getCredit(userId));
        await updateStatus(
          `📦 <b>[ MENGAMBIL APK ]</b>\n\n` +
          `<blockquote>` +
          `📡 Server  : <code>🟢 SUCCESS</code>\n` +
          `⏱ Durasi  : <code>${formatDuration(run.durationSec)}</code>\n` +
          `📦 Project : <code>${projDisplay}</code>\n\n` +
          `📊 <b>Hasil Akhir Build:</b>\n` +
          `<code>${chFinal.bar}</code>\n` +
          `${chFinal.emoji} Berhasil: <b>${chFinal.rate}%</b>  |  ❌ Gagal: <b>${chFinal.failRate}%</b>\n\n` +
          `🎉 Kompilasi sukses! Mengambil APK dari cloud...` +
          `</blockquote>`,
          "📦", "UPLOADING ARTIFACT", "Memindahkan APK ke Telegram."
        );

        // 🔥 Retry mechanism untuk artifact
        let artifacts = null;
        let retry = 0;
        while (retry < 5) {
          try {
            artifacts = await getArtifacts(runId);
            if (artifacts && artifacts.length > 0) break;
          } catch (_) {}
          retry++;
          await sleep(5000);
        }
        if (!artifacts || artifacts.length === 0) {
          removeUserJob(userId);
          if (releaseId) await deleteRelease(releaseId).catch(() => {});
          await updateStatus(`⚠️ <b>Artifact Tidak Ditemukan!</b>\n\n<blockquote>Setelah beberapa percobaan, artifact build tidak tersedia. Hubungi admin.</blockquote>`, "⚠️", "MISSING ARTIFACT", "Tidak ada artifact.");
          return;
        }

        const apkArtifact = artifacts.find(a => a.name.toLowerCase().includes("apk") || a.name.toLowerCase().includes("build")) || artifacts[0];

        if (!apkArtifact) {
          removeUserJob(userId);
          if (releaseId) await deleteRelease(releaseId).catch(() => {});
          await updateStatus(`⚠️ <b>File APK Tidak Ditemukan!</b>\n\n<blockquote>Kompilasi sukses tapi output APK tidak terdeteksi. Hubungi admin.</blockquote>`, "⚠️", "MISSING APK", "Output APK tidak ditemukan.");
          return;
        }

        const dlArtifactStart = Date.now();
        const zipDest = tmpPath(`flutter_${Date.now()}.zip`);
        await downloadArtifactZip(apkArtifact.id, zipDest);
        const dlArtifactDur = (Date.now() - dlArtifactStart) / 1000;
        const zipSizeMB = (fs.statSync(zipDest).size / 1024 / 1024).toFixed(1);
        const speedDL = (parseFloat(zipSizeMB) / dlArtifactDur).toFixed(2);

        await editHtml(chatId, msgId,
          `📦 <b>Mengambil APK...</b>\n\n` +
          `<blockquote>` +
          `🔥 Ukuran arsip: <b>${zipSizeMB} MB</b>\n` +
          `⚡ Kecepatan: <b>${speedDL} MB/s</b>\n` +
          `⏱ Durasi: ${formatDuration(dlArtifactDur)}` +
          `</blockquote>`
        );

        const zip      = new AdmZip(zipDest);
        // 🔥 Cari file .apk di mana saja (termasuk subfolder)
        let apkEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith(".apk"));
        if (!apkEntry) {
          // Coba cari dengan nama yang mengandung "app-release" atau "app-debug"
          apkEntry = zip.getEntries().find(e => e.entryName.toLowerCase().includes("release") || e.entryName.toLowerCase().includes("debug"));
        }
        // Jika masih tidak ada, coba cari di seluruh isi zip dengan pola *.apk
        if (!apkEntry) {
          apkEntry = zip.getEntries().find(e => e.entryName.match(/\.apk$/i));
        }
        if (!apkEntry) {
          removeUserJob(userId);
          fs.unlinkSync(zipDest);
          if (releaseId) await deleteRelease(releaseId).catch(() => {});
          await updateStatus(`⚠️ <b>APK Tidak Ada di Arsip!</b>\n\n<blockquote>Isi ZIP output kosong atau korup. Hubungi admin.</blockquote>`, "⚠️", "BAD ZIP", "File APK tidak ditemukan dalam arsip.");
          return;
        }

        const apkDest  = tmpPath(`flutter_${Date.now()}.apk`);
        const apkData  = apkEntry.getData();
        if (!apkData || apkData.length === 0) {
          removeUserJob(userId);
          if (fs.existsSync(zipDest)) fs.unlinkSync(zipDest);
          if (releaseId) await deleteRelease(releaseId).catch(() => {});
          await updateStatus(`⚠️ <b>APK Data Kosong!</b>\n\n<blockquote>File APK dalam arsip corrupt atau kosong. Coba build ulang.</blockquote>`, "⚠️", "CORRUPT APK", "Data APK kosong.");
          return;
        }
        fs.writeFileSync(apkDest, apkData);
        if (fs.existsSync(zipDest)) fs.unlinkSync(zipDest);
        const apkSize  = (fs.statSync(apkDest).size / 1024 / 1024).toFixed(2);

        await editHtml(chatId, msgId,
          `🚀 <b>Mengupload APK...</b>\n\n` +
          `<blockquote>Kompilasi sukses! APK <code>${apkSize} MB</code> sedang dikirim ke chat kamu...</blockquote>`
        );

        await client.sendFile(chatId, {
          file: apkDest,
          caption:
            `🎉 <b>APK SIAP DIGUNAKAN!</b>\n` +
            `────────────────────\n` +
            `<blockquote>` +
            `⏱ Durasi   : <b>${formatDuration(run.durationSec)}</b>\n` +
            `💾 Ukuran   : <b>${apkSize} MB</b>\n` +
            `🔧 Mode     : <b>${displayMode}</b>\n` +
            `🎯 Priority : ${prioText}\n` +
            `💳 Credit   : <b>${sisaCredit} tersisa</b>` +
            `</blockquote>\n\n` +
            `<i>Terima kasih sudah menggunakan ${CONFIG.BOT_NAME}! 🚀</i>`,
          parseMode: "html",
        });

        hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "success", apkSize, duration: run.durationSec, at: new Date().toISOString() });

        try {
          await client.editMessage(CONFIG.CHANNEL_USERNAME, {
            message: chanMsgId,
            text:
              `🎉 <b>BUILD SUCCESS!</b>\n` +
              `────────────────────\n` +
              `<blockquote>` +
              `👤 Developer : ${userDisplay}\n` +
              `📦 Project   : <code>${projDisplay}</code>\n` +
              `🔧 Mode      : <code>${displayMode}</code>\n` +
              `⏱ Durasi    : <code>${formatDuration(run.durationSec)}</code>\n` +
              `💾 Ukuran    : <code>${apkSize} MB</code>\n` +
              `🟢 Status    : <b>SUKSES TERKIRIM</b>` +
              `</blockquote>`,
            parseMode: "html",
          });
        } catch (_) {}

        if (fs.existsSync(apkDest)) fs.unlinkSync(apkDest);
        await safeCleanup(releaseId, userId);
        return;

      } else {
        db.incrementStat("failed");
        await updateStatus(
          `❌ <b>[ BUILD GAGAL ]</b>\n\n` +
          `<blockquote>` +
          `📡 Server  : <code>🔴 FAILED</code>\n` +
          `🔧 Mode    : <code>${displayMode}</code>\n` +
          `📦 Project : <code>${projDisplay}</code>\n\n` +
          `🔍 Mengambil log error dari server...` +
          `</blockquote>`,
          "❌", "BUILD FAILED", "Error pada source code."
        );

        if (releaseId) await deleteRelease(releaseId).catch(() => {});
        await sleep(3000);

        const errDetail = await Promise.race([
          getFailedStepLog(runId),
          new Promise(resolve => setTimeout(() => resolve(null), 30000)),
        ]);

        hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "failed", duration: run.durationSec, at: new Date().toISOString() });

        let errText =
          `❌ <b>BUILD FAILED</b>\n\n` +
          `<blockquote>` +
          `🔴 Step gagal : <code>${errDetail?.stepName || "Kompilasi Utama"}</code>\n` +
          `⏱ Durasi     : <code>${formatDuration(run.durationSec)}</code>` +
          `</blockquote>`;

        if (errDetail?.errorLines?.length) {
          errText += `\n\n<pre>${errDetail.errorLines.join("\n").slice(0, 1500)}</pre>`;
          await editHtml(chatId, msgId, errText);

          const logFile = tmpPath(`build_error_${userId}_${Date.now()}.txt`);
          fs.writeFileSync(logFile, `BUILD FAILED\nStep: ${errDetail.stepName}\n=====\n${errDetail.errorLines.join("\n")}`);
          await client.sendFile(chatId, {
            file: logFile,
            caption: `📄 <b>Full Build Error Log</b>\n\n<i>Gunakan file ini untuk menemukan baris kode yang error secara detail.</i>`,
            parseMode: "html",
          });
          if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
        } else {
          errText += `\n\n<blockquote>Gagal mengambil log error otomatis dari server.</blockquote>`;
          await editHtml(chatId, msgId, errText);
        }

        await safeCleanup(null, userId);
        return;
      }
    }
    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
}

// ─── QUEUE ──────────────────────────────────────────────────────────────────
const queueMessages = new Map();

async function handleQueue(chatId, delId = null) {
  try {
    const qs   = getQueueStats();
    const cs   = db.getStats();
    const jobs = getSortedActiveJobs();

    let text =
      `<b>📊 STATUS BUILD QUEUE</b>\n` +
      `────────────────────\n` +
      `<blockquote>` +
      `⏳ Menunggu  : <b>${qs.waiting}</b>\n` +
      `☁️ Uploading : <b>${qs.uploading}</b>\n` +
      `⚙️ Building  : <b>${qs.building}</b>` +
      `</blockquote>\n\n`;

    if (jobs.length === 0) {
      text += `<i>🚫 Tidak ada build aktif saat ini.</i>\n\n`;
    } else {
      text += `🔥 <b>Build Aktif (${jobs.length})</b>\n\n`;
      jobs.forEach((j, i) => {
        const icon = j.status === "building" ? "⚙️" : j.status === "uploading" ? "☁️" : "⏳";
        const prioIcon = getUserPriority(j.userId) === 1 ? "👑" : getUserPriority(j.userId) === 2 ? "🤝" : "👤";
        const elapsed  = formatDuration(elapsedSec(j.updatedAt));
        const usr      = j.fullName && j.fullName !== "Unknown User" ? j.fullName : (j.username ? `@${j.username}` : `User_${j.userId}`);
        text +=
          `${i + 1}. ${prioIcon} ${icon} <b>${usr}</b>\n` +
          `<blockquote>` +
          `Status : ${statusLabel(j.status)}\n` +
          `Mode   : ${j.buildType === "debug" ? "🐞 Debug" : j.type === "web2apk" ? "🌐 Web2APK" : "🚀 Release"}\n` +
          `Aktif  : ${elapsed}` +
          `</blockquote>\n`;
      });
    }

    const chQ = renderChance(buildChanceRate());
    text +=
      `\n<blockquote>` +
      `🟢 Sukses: <b>${cs.success}</b>  |  🔴 Gagal: <b>${cs.failed}</b>\n` +
      `📊 <code>${chQ.bar}</code> ${chQ.emoji} <b>${chQ.rate}%</b>\n` +
      `🕒 ${nowTimeWib()} WIB` +
      `</blockquote>`;

    const btns = [[{ text: "🔄 Refresh", data: "queue" }, { text: "🏠 Menu Utama", data: "start" }]];

    if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
    else {
      const old = queueMessages.get(chatId);
      if (old) { try { await client.deleteMessages(chatId, [old]); } catch (_) {} }
    }

    const m = await client.sendMessage(chatId, { message: text, buttons: buildButtons(btns), parseMode: "html" });
    queueMessages.set(chatId, m.id);
  } catch (err) {
    console.error("handleQueue error:", err);
  }
}

// ─── STATUS BOT ─────────────────────────────────────────────────────────────
async function handleStatus(chatId, userId, delId = null) {
  const qs      = getQueueStats();
  const uptime  = formatDuration(Math.floor(process.uptime()));
  const cs      = db.getStats();
  const total   = cs.success + cs.failed;
  const rate    = total > 0 ? ((cs.success / total) * 100).toFixed(1) : "0.0";

  const totalRam = (os.totalmem() / 1073741824).toFixed(2);
  const freeRam  = (os.freemem()  / 1073741824).toFixed(2);
  const usedRam  = (totalRam - freeRam).toFixed(2);
  const ramPct   = ((usedRam / totalRam) * 100).toFixed(1);
  const cpus     = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() || "Unknown";
  const cpuLoad  = (os.loadavg()[0] * 100 / cpus.length).toFixed(1);

  let disk = { total: "N/A", used: "N/A", free: "N/A", pct: "N/A" };
  try {
    const df = execSync("df -h / | tail -1").toString().trim().split(/\s+/);
    if (df.length >= 5) disk = { total: df[1], used: df[2], free: df[3], pct: df[4] };
  } catch (_) {}

  let cloud = "Generic KVM";
  try {
    const v = execSync("cat /sys/class/dmi/id/sys_vendor 2>/dev/null").toString().trim().toLowerCase();
    const p = execSync("cat /sys/class/dmi/id/product_name 2>/dev/null").toString().trim().toLowerCase();
    if (v.includes("digitalocean")) cloud = "DigitalOcean Droplet";
    else if (v.includes("amazon")) cloud = "AWS EC2";
    else if (v.includes("google")) cloud = "Google Cloud (GCP)";
    else if (v.includes("linode")) cloud = "Linode VPS";
    else if (v.includes("vultr"))  cloud = "Vultr VPS";
    else if (v.includes("qemu") || p.includes("kvm")) cloud = "KVM Virtual Server";
    else if (v.length > 0) cloud = `${v.toUpperCase()}`;
  } catch (_) {}

  const ping = await new Promise(resolve => {
    const start = Date.now();
    const s = new net.Socket();
    s.setTimeout(2000);
    s.connect(443, "api.github.com", () => {
      const ms = Date.now() - start;
      s.destroy();
      resolve(`${ms}ms — ${ms > 350 ? "🔴 Lambat" : ms > 150 ? "🟡 Sedang" : "🟢 Bagus"}`);
    });
    s.on("error",   () => { s.destroy(); resolve("❌ Gagal"); });
    s.on("timeout", () => { s.destroy(); resolve("❌ Timeout"); });
  });

  await sendHtml(chatId,
    `⚙️ <b>INFRASTRUKTUR BOT</b>\n` +
    `────────────────────\n\n` +
    `<b>🤖 Bot Info</b>\n` +
    `<blockquote>` +
    `📦 Nama    : ${CONFIG.BOT_NAME} <code>v${CONFIG.BOT_VERSION}</code>\n` +
    `🟢 Status  : Online / Active\n` +
    `⏱ Uptime  : ${uptime}\n` +
    `🔥 User DB : ${db.getAllUsers().length} pengguna\n` +
    `✅ Sukses  : ${cs.success} build\n` +
    `❌ Gagal   : ${cs.failed} build\n` +
    `📈 Rate    : <b>${rate}%</b>` +
    `</blockquote>\n\n` +
    (() => { const chS = renderChance(buildChanceRate()); return `<b>📊 Live Build Chance</b>\n<blockquote><code>${chS.bar}</code>\n${chS.emoji} Berhasil: <b>${chS.rate}%</b>  |  ❌ Gagal: <b>${chS.failRate}%</b></blockquote>\n\n`; })() +
    `<b>📊 Queue Engine</b>\n` +
    `<blockquote>` +
    `⏳ Menunggu  : ${qs.waiting}\n` +
    `☁️ Uploading : ${qs.uploading}\n` +
    `⚙️ Building  : ${qs.building}` +
    `</blockquote>\n\n` +
    `<b>☁️ Cloud Server</b>\n` +
    `<blockquote>` +
    `🌐 Provider : <code>${cloud}</code>\n` +
    `⚡ Ping     : <code>${ping}</code>\n` +
    `🐧 OS       : ${os.type()} ${os.release()} (${os.arch()})` +
    `</blockquote>\n\n` +
    `<b>💾 Hardware</b>\n` +
    `<blockquote>` +
    `🧠 CPU  : ${cpuModel} (${cpus.length} Core)\n` +
    `⚡ Load : <code>${cpuLoad}%</code>\n` +
    `🗄️ RAM  : <code>${usedRam}/${totalRam} GB (${ramPct}%)</code>\n` +
    `💽 SSD  : <code>${disk.used}/${disk.total} (${disk.pct})</code>` +
    `</blockquote>\n\n` +
    `<i>🕒 ${nowWib()} WIB</i>`,
    [[{ text: "🔄 Refresh", data: "status" }, { text: "🏠 Menu Utama", data: "start" }]],
    delId
  );
}

// ─── HELP ──────────────────────────────────────────────────────────────────
async function handleHelp(chatId, delId = null) {
  await sendHtml(chatId,
    `📖 <b>PANDUAN ${CONFIG.BOT_NAME.toUpperCase()}</b>\n` +
    `────────────────────\n\n` +
    `<b>🚀 Build APK Flutter</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🚀 Mulai Build APK</b>\n` +
    `2️⃣ Pilih mode Debug / Release\n` +
    `3️⃣ Kirim file ZIP project Flutter\n` +
    `4️⃣ Bot build di cloud & kirim APK otomatis` +
    `</blockquote>\n\n` +
    `<b>🌐 Web to APK</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🌐 Web to APK</b>\n` +
    `2️⃣ Kirim URL website\n` +
    `3️⃣ Kirim nama aplikasi\n` +
    `4️⃣ Kirim logo/icon (PNG/JPG)\n` +
    `5️⃣ APK dikirim otomatis` +
    `</blockquote>\n\n` +
    `<b>📋 Ketentuan</b>\n` +
    `<blockquote>` +
    `• Maks <b>1 build aktif</b> per user\n` +
    `• Maks ukuran ZIP: <b>2 GB</b>\n` +
    `• Timeout build: <b>${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} menit</b>` +
    `</blockquote>\n\n` +
    `<b>🔍 Cek User & DC Server</b>\n` +
    `<blockquote>` +
    `Klik <b>🔍 Cek User/Profil</b> di menu atau ketik:\n` +
    `/cekuser @username — Cek profil user\n` +
    `/cekid 123456789 — Cek profil dari ID\n` +
    `/cekdc — Lihat info semua DC Telegram` +
    `</blockquote>\n\n` +
    `<b>💳 Sistem Credit & Pembelian</b>\n` +
    `<blockquote>` +
    `• Setiap build menggunakan <b>1 credit</b>\n` +
    `• Owner, Admin, Reseller: <b>Unlimited</b> (exempt)\n` +
    `• User baru mendapat <b>7 credit gratis</b>\n` +
    `• Klaim mingguan: <b>5 credit</b> setiap 7 hari\n` +
    `• Beli credit via QRIS: klik <b>💰 Beli Credit</b>\n` +
    `• Admin akan approve setelah pembayaran diverifikasi` +
    `</blockquote>\n\n` +
    `<b>🔑 Perintah Admin/Owner</b>\n` +
    `<blockquote>` +
    `/addpremium &lt;id&gt; — Tambah premium user (Owner only)\n` +
    `/removepremium &lt;id&gt; — Cabut premium user (Owner only)\n` +
    `/listpremium — Lihat daftar premium (Owner only)\n` +
    `/addreseller &lt;id&gt; — Tambah reseller\n` +
    `/removereseller &lt;id&gt; — Hapus reseller\n` +
    `/addcredit &lt;id&gt; &lt;jumlah&gt; — Tambah credit user\n` +
    `/reducecredit &lt;id&gt; &lt;jumlah&gt; — Kurangi credit user\n` +
    `/resetcredit &lt;id&gt; — Reset credit ke 0\n` +
    `/broadcast — Broadcast ke semua user\n` +
    `/searchuser &lt;query&gt; — Cari user\n` +
    `/userinfo &lt;id&gt; — Info detail user\n` +
    `/deleteuser &lt;id&gt; — Hapus user dari DB\n` +
    `/banuser &lt;id&gt; [alasan] — Ban user\n` +
    `/unbanuser &lt;id&gt; — Unban user\n` +
    `/dmuser &lt;id&gt; &lt;pesan&gt; — Kirim DM ke user\n` +
    `/exportusers — Export CSV semua user\n` +
    `/buildhistory — Riwayat build\n` +
    `/killbuild &lt;id&gt; — Force kill build user\n` +
    `/approvepayment &lt;id&gt; — Setujui pembayaran QRIS\n` +
    `/rejectpayment &lt;id&gt; — Tolak pembayaran QRIS\n` +
    `/setqris — Owner set foto QRIS (kirim foto setelah perintah)\n` +
    `/setpaymentinfo &lt;teks&gt; — Owner set instruksi pembayaran` +
    `</blockquote>`,
    [
      [{ text: "🚀 Mulai Build APK", data: "build"   }, { text: "🌐 Web to APK",    data: "web2apk"  }],
      [{ text: "💰 Beli Credit",     data: "buy_credit" }],
      [{ text: "🔍 Cek User/Profil", data: "cek_user"}, { text: "🌐 Info DC Server", data: "cek_dc"  }],
      [{ text: "🏠 Menu Utama",      data: "start"   }],
    ],
    delId
  );
}

// ─── WEB2APK ───────────────────────────────────────────────────────────────
async function handleWeb2Apk(chatId, userId, delId = null) {
  if (CONFIG.WEB2APK_MAINTENANCE) {
    await sendHtml(chatId,
      `🛠️ <b>Fitur Dalam Maintenance</b>\n\n` +
      `<blockquote>Fitur Web to APK sementara ditutup untuk peningkatan sistem.\n\nGunakan Build APK biasa untuk sementara.</blockquote>`,
      [[{ text: "🏠 Menu Utama", data: "start" }]], delId
    );
    return;
  }
  if (isUserBuilding(userId)) {
    const job = getUserJob(userId);
    await sendHtml(chatId,
      `⚠️ <b>Build Aktif!</b>\n\n<blockquote>Status: ${statusLabel(job.status)}\n\nTunggu selesai atau batalkan dulu.</blockquote>`,
      [[{ text: "❌ Batalkan Build", data: "cancel" }]], delId
    );
    return;
  }

  let username = null, fullName = "Unknown User";
  try {
    const e = await client.getEntity(userId);
    username = e?.username || null;
    fullName = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown User";
  } catch (_) {}

  const priority = getUserPriority(userId);
  setUserJob(userId, { status: "waiting_url", chatId, userId, username, fullName, type: "web2apk", updatedAt: Date.now(), priority });

  const prioMsg = priority === 1 ? `\n\n<blockquote>👑 <b>OWNER PRIORITY (Level 1)</b></blockquote>`
    : priority === 2           ? `\n\n<blockquote>🤝 <b>RESELLER PRIORITY (Level 2)</b></blockquote>`
    : "";

  await sendHtml(chatId,
    `🌐 <b>Web to APK — Langkah 1/3</b>\n` +
    `────────────────────\n\n` +
    `Kirim <b>URL website</b> yang ingin dijadikan APK.${prioMsg}\n\n` +
    `<blockquote>📌 Contoh: <code>https://example.com</code></blockquote>`,
    [[{ text: "❌ Batalkan", data: "cancel" }]], delId
  );
}

async function handleWeb2ApkUrl(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text   = event.message.text?.trim();
  const job    = getUserJob(userId);
  if (!job || job.status !== "waiting_url" || job.type !== "web2apk") return;
  try { new URL(text); } catch {
    await sendHtml(chatId, `❌ <b>URL tidak valid!</b>\n\n<blockquote>Contoh: <code>https://example.com</code></blockquote>`);
    return;
  }
  setUserJob(userId, { ...job, status: "waiting_appname", webUrl: text, updatedAt: Date.now() });
  await sendHtml(chatId,
    `✅ <b>URL Tersimpan!</b>\n\n` +
    `🌐 <b>Web to APK — Langkah 2/3</b>\n` +
    `────────────────────\n\n` +
    `Kirim <b>nama aplikasi</b> yang diinginkan.\n\n` +
    `<blockquote>📌 Contoh: <code>Toko Online Saya</code></blockquote>`,
    [[{ text: "❌ Batalkan", data: "cancel" }]]
  );
}

async function handleWeb2ApkName(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text   = event.message.text?.trim();
  const job    = getUserJob(userId);
  if (!job || job.status !== "waiting_appname" || job.type !== "web2apk") return;
  setUserJob(userId, { ...job, status: "waiting_icon", appName: text, updatedAt: Date.now() });
  await sendHtml(chatId,
    `✅ <b>Nama App Tersimpan!</b>\n\n` +
    `🌐 <b>Web to APK — Langkah 3/3</b>\n` +
    `────────────────────\n\n` +
    `Kirim <b>foto/logo</b> untuk icon APK.\n\n` +
    `<blockquote>📌 Tips:\n• Kirim sebagai foto atau file gambar\n• Disarankan ukuran 1:1 (persegi)\n• Format: PNG, JPG</blockquote>`,
    [[{ text: "❌ Batalkan", data: "cancel" }]]
  );
}

async function handleWeb2ApkIcon(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const job    = getUserJob(userId);
  if (!job || job.status !== "waiting_icon" || job.type !== "web2apk") return false;
  const media = event.message.media;
  if (!media) return false;
  if (!media.photo && !media.document) {
    await sendHtml(chatId, `⚠️ <b>Kirim ikon dalam bentuk Foto atau File Gambar!</b>`);
    return true;
  }

  const statusMsg = await sendHtml(chatId,
    `⚙️ <b>Memproses Web to APK...</b>\n\n` +
    `<blockquote>🌐 URL  : <code>${job.webUrl}</code>\n📱 Nama : <code>${job.appName}</code>\n\n🔥 Memproses icon...</blockquote>`
  );
  const msgId = statusMsg.id;

  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
    const iconPath = tmpPath(`icon_${userId}_${Date.now()}.png`);
    await client.downloadMedia(event.message, { outputFile: iconPath });
    await editHtml(chatId, msgId,
      `⚙️ <b>Memproses Web to APK...</b>\n\n` +
      `<blockquote>🌐 URL  : <code>${job.webUrl}</code>\n📱 Nama : <code>${job.appName}</code>\n\n☁️ Menyiapkan aset di GitHub Release...</blockquote>`
    );
    const tag = genTag(userId);
    const { releaseId: iconReleaseId, uploadUrl } = await createReleaseOnly(tag);
    await uploadAssetFile(uploadUrl, iconPath, "icon.png", "image/png");
    if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath);
    const iconUrl = await publishRelease(iconReleaseId);
    if (!iconUrl) throw new Error("URL icon gagal diambil!");
    const runId = await triggerWeb2ApkWorkflow(job.webUrl, job.appName, iconUrl);
    setUserJob(userId, { ...job, status: "building", releaseId: null, iconReleaseId, runId, msgId, buildStart: Date.now(), updatedAt: Date.now() });
    await editHtml(chatId, msgId,
      `⚙️ <b>Build Web to APK Dimulai!</b>\n\n` +
      `<blockquote>🌐 URL  : <code>${job.webUrl}</code>\n📱 Nama : <code>${job.appName}</code>\n🆔 Run  : <code>${runId}</code>\n\n🔍 Memantau progress...</blockquote>`
    );
    monitorBuild(userId, chatId, msgId, runId, null).catch(async err => {
      removeUserJob(userId);
      await editHtml(chatId, msgId, `❌ <b>Error Build Server!</b>\n\n<blockquote>${err.message}</blockquote>`);
    });
  } catch (err) {
    removeUserJob(userId);
    await editHtml(chatId, msgId, `❌ <b>Gagal Memproses Asset!</b>\n\n<blockquote>${err.message}</blockquote>`);
  }
  return true;
}

// ─── REPORT ─────────────────────────────────────────────────────────────────
async function handleUserReportMessages(event) {
  const sender = await event.message.getSender();
  const userId = Number(sender?.id);
  const chatId = event.chatId;
  const state  = userStates.get(userId);
  if (!state) return false;

  if (state.step === "WAITING_CEK_USER") {
    userStates.delete(userId);
    const q = event.message.text?.trim();
    if (!q) { await sendHtml(chatId, "❌ Input tidak valid!"); return true; }
    await _doCheckUser(chatId, userId, q);
    return true;
  }

  if (state.step === "WAITING_FOR_REASON") {
    if (!event.message.text || event.message.text.length < 10) {
      await client.sendMessage(chatId, {
        message: "⚠️ **Mohon berikan alasan yang lebih detail (minimal 10 karakter).**",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }
    userStates.set(userId, { step: "WAITING_FOR_SCREENSHOT", reason: event.message.text });
    await client.sendMessage(chatId, {
      message: "📸 **BUKTI SCREENSHOT**\n\nKirimkan **1 Foto/Screenshot** bukti pendukung.",
      parseMode: "md",
      buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]])
    });
    return true;
  }

  if (state.step === "WAITING_FOR_SCREENSHOT") {
    if (!event.message.media || !(event.message.media instanceof Api.MessageMediaPhoto)) {
      await client.sendMessage(chatId, {
        message: "⚠️ **Format salah! Kirimkan bukti berupa Foto/Gambar.**",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }
    const username = sender?.username ? `@${sender.username}` : "—";
    const name     = sender?.firstName || "User";
    try {
      const reportPath = tmpPath(`report_${userId}_${Date.now()}.jpg`);
      await client.downloadMedia(event.message, { outputFile: reportPath });
      await client.sendMessage(CONFIG.CHANNEL_USERNAME, {
        message:
          `🚨 <b>LAPORAN MASUK</b>\n\n` +
          `<blockquote>` +
          `👤 Nama    : ${name}\n` +
          `🆔 ID      : <code>${userId}</code>\n` +
          `🌐 Username: ${username}\n\n` +
          `📝 Alasan:\n${state.reason}` +
          `</blockquote>`,
        file: reportPath,
        parseMode: "html",
        buttons: buildButtons([
          [{ text: "✅ Selesai", data: `adm_fix_${userId}` }],
          [{ text: "🔒 Blokir", data: `adm_blk_${userId}` }, { text: "🔓 Unblokir", data: `adm_unblk_${userId}` }]
        ])
      });
      if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
      await client.sendMessage(chatId, {
        message: `✅ **Laporan Terkirim!**\n\nTerima kasih, laporan kamu sudah masuk ke sistem admin.`,
        parseMode: "md"
      });
    } catch (e) {
      await client.sendMessage(chatId, { message: "❌ Gagal mengirim laporan." });
    }
    userStates.delete(userId);
    return true;
  }

  // ─── HANDLE WAITING_QRIS (owner set QRIS) ───────────────────────────────
  if (state.step === "WAITING_QRIS") {
    if (!isOwner(userId)) {
      userStates.delete(userId);
      return false;
    }
    if (!event.message.media || !(event.message.media instanceof Api.MessageMediaPhoto)) {
      await sendHtml(chatId, `⚠️ <b>Kirim foto QRIS (format gambar).</b>`);
      return true;
    }
    try {
      const filePath = tmpPath(`qris_${Date.now()}.png`);
      await client.downloadMedia(event.message, { outputFile: filePath });
      const config = getPaymentConfig();
      config.qrisPath = filePath;
      savePaymentConfig(config);
      userStates.delete(userId);
      await sendHtml(chatId,
        `✅ <b>QRIS berhasil diperbarui!</b>\n\n<blockquote>File QRIS baru disimpan di: <code>${filePath}</code>\n\nSekarang user akan melihat QRIS ini saat membeli credit.</blockquote>`,
        [[{ text: "🏠 Menu Utama", data: "start" }]]
      );
    } catch (e) {
      await sendHtml(chatId, `❌ Gagal menyimpan QRIS: <code>${e.message}</code>`);
    }
    return true;
  }

  return false;
}

// ─── ADMIN COMMANDS ─────────────────────────────────────────────────────────
async function handleAddReseller(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, `❌ <b>Akses ditolak!</b>`); return; }
  if (!targetId) { await sendHtml(chatId, `➕ <b>Tambah Reseller</b>\n\n<blockquote>Gunakan: <code>/addreseller 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (isNaN(num)) { await sendHtml(chatId, `❌ <b>ID tidak valid!</b>`); return; }
  const info = db.getUserById(num);
  if (rdb.add(num, info?.username, userId)) {
    await sendHtml(chatId, `✅ <b>Reseller ditambahkan!</b>\n\n<blockquote>🆔 ID: <code>${num}</code>\n👤 Username: ${info?.username || "—"}\n🎯 Priority Level 2</blockquote>`);
    try { await client.sendMessage(num, { message: `🎉 **SELAMAT!**\n\nKamu sekarang menjadi **RESELLER** dari ${CONFIG.BOT_NAME}!\n\n✨ Priority Level 2 - Build diprioritaskan!`, parseMode: "md" }); } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ <b>User ID <code>${num}</code> sudah menjadi reseller.</b>`);
  }
}

async function handleRemoveReseller(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, `❌ <b>Akses ditolak!</b>`); return; }
  if (!targetId) { await sendHtml(chatId, `➖ <b>Hapus Reseller</b>\n\n<blockquote>Gunakan: <code>/removereseller 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (rdb.remove(num)) {
    await sendHtml(chatId, `✅ <b>Reseller dihapus!</b>\n\n<blockquote>🆔 ID: <code>${num}</code></blockquote>`);
    try { await client.sendMessage(num, { message: `⚠️ **PEMBERITAHUAN**\n\nStatus reseller kamu telah dicabut.`, parseMode: "md" }); } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ <b>ID <code>${num}</code> bukan reseller.</b>`);
  }
}

// ─── PREMIUM COMMANDS ──────────────────────────────────────────────────────
async function handleAddPremium(chatId, userId, args) {
  if (!isOwner(userId)) { await sendHtml(chatId, `❌ <b>Hanya Owner yang bisa menambah Premium!</b>`); return; }
  if (!args) { await sendHtml(chatId, `⭐ <b>Tambah Premium</b>\n\n<blockquote>Gunakan: <code>/addpremium 123456789 [catatan]</code></blockquote>`); return; }
  const parts = args.trim().split(/\s+/);
  const num   = Number(parts[0]);
  const note  = parts.slice(1).join(" ") || "";
  if (isNaN(num)) { await sendHtml(chatId, `❌ <b>ID tidak valid!</b>`); return; }
  if (isOwner(num) || isAdmin(num)) { await sendHtml(chatId, `❌ Owner/Admin tidak perlu Premium (sudah exempt).`); return; }
  const info = db.getUserById(num);
  if (pdb.add(num, info?.username, userId, note)) {
    await sendHtml(chatId,
      `⭐ <b>Premium Ditambahkan!</b>\n\n` +
      `<blockquote>` +
      `🆔 ID       : <code>${num}</code>\n` +
      `👤 Username : ${info?.username || "—"}\n` +
      `📝 Catatan  : ${note || "—"}\n` +
      `🎯 Priority : Level 3\n` +
      `💳 Credit   : ∞ Unlimited` +
      `</blockquote>`
    );
    try {
      await client.sendMessage(num, {
        message:
          `⭐ <b>SELAMAT! KAMU SEKARANG PREMIUM!</b>\n────────────────────\n\n` +
          `<blockquote>` +
          `Akun kamu telah diupgrade ke status <b>PREMIUM</b>!\n\n` +
          `✨ Keuntungan Premium:\n` +
          `• 💳 Build <b>Unlimited</b> (tanpa credit)\n` +
          `• 🚀 Priority build Level 3\n` +
          `• ⭐ Badge Premium di profil` +
          `</blockquote>\n\n` +
          `Ketik /start untuk melihat perubahan!`,
        parseMode: "html",
      });
    } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ <b>User ID <code>${num}</code> sudah berstatus Premium.</b>`);
  }
}

async function handleRemovePremium(chatId, userId, targetId) {
  if (!isOwner(userId)) { await sendHtml(chatId, `❌ <b>Hanya Owner yang bisa mencabut Premium!</b>`); return; }
  if (!targetId) { await sendHtml(chatId, `➖ <b>Hapus Premium</b>\n\n<blockquote>Gunakan: <code>/removepremium 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (pdb.remove(num)) {
    await sendHtml(chatId, `✅ <b>Status Premium Dicabut!</b>\n\n<blockquote>🆔 ID: <code>${num}</code></blockquote>`);
    try { await client.sendMessage(num, { message: `⚠️ <b>Status Premium kamu telah dicabut.</b>\n\nHubungi owner untuk informasi lebih lanjut.`, parseMode: "html" }); } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ <b>ID <code>${num}</code> bukan pengguna Premium.</b>`);
  }
}

async function handleListPremium(chatId, userId, editId = null) {
  if (!isOwner(userId)) { await sendHtml(chatId, "❌ Hanya Owner!"); return; }
  const all = pdb.all();
  let text = `<b>⭐ DAFTAR PREMIUM (${all.length})</b>\n────────────────────\n\n`;
  if (!all.length) { text += `<i>Belum ada pengguna Premium.</i>`; }
  else { all.forEach((p, i) => { text += `${i+1}. ⭐ <b>PREMIUM</b>\n<blockquote>🆔 ID: <code>${p.userId}</code>\n🌐 Username: ${p.username||"—"}\n📝 Catatan: ${p.note||"—"}\n📅 Sejak: ${new Date(p.addedAt).toLocaleDateString("id-ID")}</blockquote>\n`; }); }
  const btns = [[{ text: "◀ Owner Panel", data: "owner_panel" }]];
  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── CREDIT COMMANDS ──────────────────────────────────────────────────────
async function handleAddCredit(chatId, userId, args) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, `❌ <b>Akses ditolak!</b>`); return; }
  if (!args) { await sendHtml(chatId, `➕ <b>Tambah Credit</b>\n\n<blockquote>Gunakan: <code>/addcredit 123456789 10</code></blockquote>`); return; }
  const parts = args.trim().split(/\s+/);
  const tid   = parseInt(parts[0]), amt = parseInt(parts[1]);
  if (isNaN(tid) || isNaN(amt) || amt <= 0) { await sendHtml(chatId, `❌ <b>Format salah!</b>\n\n<blockquote>Contoh: <code>/addcredit 123456789 10</code></blockquote>`); return; }
  const newTotal = cdb.addCredit(tid, amt, userId);
  await sendHtml(chatId, `✅ <b>Credit Ditambahkan!</b>\n\n<blockquote>👤 User: <code>${tid}</code>\n➕ Ditambah: <b>${amt}</b> credit\n💳 Total: <b>${newTotal}</b> credit</blockquote>`);
  try { await client.sendMessage(tid, { message: `💳 <b>Credit Ditambahkan!</b>\n\nKamu mendapat <b>${amt}</b> credit build tambahan!\nTotal credit: <b>${newTotal}</b>\n\nKetik /start untuk mulai build!`, parseMode: "html" }); } catch (_) {}
}

async function handleReduceCredit(chatId, userId, args) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, `❌ <b>Akses ditolak!</b>`); return; }
  if (!args) { await sendHtml(chatId, `➖ <b>Kurangi Credit</b>\n\n<blockquote>Gunakan: <code>/reducecredit 123456789 5</code></blockquote>`); return; }
  const parts = args.trim().split(/\s+/);
  const tid   = parseInt(parts[0]), amt = parseInt(parts[1]);
  if (isNaN(tid) || isNaN(amt) || amt <= 0) { await sendHtml(chatId, `❌ <b>Format salah!</b>`); return; }
  const cur = cdb.getCredit(tid), newTotal = Math.max(0, cur - amt);
  cdb.setCredit(tid, newTotal, userId);
  await sendHtml(chatId, `✅ <b>Credit Dikurangi!</b>\n\n<blockquote>👤 User: <code>${tid}</code>\n➖ Dikurangi: <b>${amt}</b>\n💳 Sisa: <b>${newTotal}</b> credit</blockquote>`);
}

async function handleResetCredit(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, `❌ <b>Akses ditolak!</b>`); return; }
  const tid = parseInt(targetId);
  if (isNaN(tid)) { await sendHtml(chatId, `🗑️ <b>Reset Credit</b>\n\n<blockquote>Gunakan: <code>/resetcredit 123456789</code></blockquote>`); return; }
  cdb.setCredit(tid, 0, userId);
  await sendHtml(chatId, `✅ <b>Credit Direset!</b>\n\n<blockquote>👤 User: <code>${tid}</code>\n💳 Credit: <b>0</b></blockquote>`);
}

// ─── PAYMENT (QRIS) ──────────────────────────────────────────────────────
const PAYMENT_PACKAGES = [
  { name: "Paket 10 Credit", credit: 10, price: 10000 },
  { name: "Paket 25 Credit", credit: 25, price: 20000 },
  { name: "Paket 50 Credit", credit: 50, price: 30000 },
];

async function handleBuyCredit(chatId, userId, delId = null) {
  // Cek apakah user sedang dalam build?
  if (isUserBuilding(userId)) {
    return sendHtml(chatId, `⚠️ <b>Anda sedang dalam proses build!</b>\n\n<blockquote>Selesaikan atau batalkan build terlebih dahulu.</blockquote>`, [[{ text: "❌ Batalkan Build", data: "cancel" }]]);
  }

  // Ambil konfigurasi payment
  const config = getPaymentConfig();
  const qrImagePath = config.qrisPath && fs.existsSync(config.qrisPath) ? config.qrisPath : null;
  const instructions = config.instructions || "Bayar via QRIS di bawah ini, lalu kirim bukti transfer ke bot.";

  let text =
    `💰 <b>BELI CREDIT VIA QRIS</b>\n` +
    `────────────────────\n\n` +
    `<blockquote>Pilih paket yang ingin dibeli.\n\n` +
    `Setelah memilih, kamu akan mendapatkan instruksi pembayaran.\n` +
    `Kirim bukti transfer/QRIS untuk diverifikasi oleh admin.</blockquote>\n\n`;

  const btns = PAYMENT_PACKAGES.map(p => [
    { text: `${p.name} (Rp ${p.price.toLocaleString()})`, data: `payment_package_${p.credit}_${p.price}` }
  ]);
  btns.push([{ text: "❌ Batal", data: "start" }]);

  if (delId) {
    await client.editMessage(chatId, { message: delId, text, buttons: buildButtons(btns), parseMode: "html" });
  } else {
    await sendHtml(chatId, text, btns);
  }
}

async function handlePaymentPackage(chatId, userId, data) {
  // data format: payment_package_<credit>_<price>
  const parts = data.split("_");
  const credit = parseInt(parts[2]);
  const price = parseInt(parts[3]);
  const packageName = PAYMENT_PACKAGES.find(p => p.credit === credit && p.price === price)?.name || `Paket ${credit} Credit`;

  // Buat pending payment
  const entry = paydb.create(userId, packageName, credit, price);

  // Ambil konfigurasi payment
  const config = getPaymentConfig();
  const qrImagePath = config.qrisPath && fs.existsSync(config.qrisPath) ? config.qrisPath : null;
  const instructions = config.instructions || "Bayar via QRIS di bawah ini, lalu kirim bukti transfer ke bot.";

  let paymentMsg =
    `🧾 <b>INVOICE PEMBAYARAN</b>\n` +
    `────────────────────\n\n` +
    `<blockquote>` +
    `📦 Paket     : ${packageName}\n` +
    `💳 Credit    : <b>${credit}</b>\n` +
    `💰 Harga     : <b>Rp ${price.toLocaleString()}</b>\n` +
    `🆔 ID Order  : <code>${entry.id}</code>\n` +
    `📅 Dibuat    : ${nowWib()}` +
    `</blockquote>\n\n`;

  if (qrImagePath) {
    paymentMsg +=
      `📸 <b>Scan QRIS berikut untuk membayar:</b>\n\n` +
      `<i>Setelah bayar, kirim screenshot bukti transfer ke chat ini.</i>`;
  } else {
    paymentMsg +=
      `⚠️ <b>QRIS tidak tersedia</b> — silakan hubungi admin untuk pembayaran manual.\n\n` +
      `📌 Instruksi: ${instructions}\n\n` +
      `Setelah bayar, kirim bukti transfer ke chat ini.`;
  }

  const btns = [
    [{ text: "✅ Saya Sudah Bayar", data: `payment_confirm_${entry.id}` }],
    [{ text: "❌ Batalkan Pesanan", data: "payment_cancel" }]
  ];

  // Kirim pesan dengan QR (jika ada)
  let msg;
  if (qrImagePath) {
    msg = await client.sendFile(chatId, {
      file: qrImagePath,
      caption: paymentMsg,
      parseMode: "html",
      buttons: buildButtons(btns)
    });
  } else {
    msg = await client.sendMessage(chatId, {
      message: paymentMsg,
      parseMode: "html",
      buttons: buildButtons(btns)
    });
  }

  // Simpan message ID untuk state
  userStates.set(userId, { step: "WAITING_PAYMENT_CONFIRM", paymentId: entry.id, msgId: msg.id });
}

async function handlePaymentConfirm(chatId, userId, paymentId) {
  const entry = paydb.get(paymentId);
  if (!entry) {
    return sendHtml(chatId, `❌ <b>Order tidak ditemukan!</b>`);
  }
  if (entry.userId !== userId) {
    return sendHtml(chatId, `❌ <b>Order ini milik user lain.</b>`);
  }
  if (entry.status !== "pending") {
    return sendHtml(chatId, `ℹ️ <b>Order ini sudah ${entry.status === "approved" ? "disetujui" : "ditolak"}.</b>`);
  }

  userStates.set(userId, { step: "WAITING_PAYMENT_PROOF", paymentId: entry.id });
  await sendHtml(chatId,
    `📸 <b>Kirim Bukti Pembayaran</b>\n\n` +
    `<blockquote>Silakan kirim foto/screenshot bukti transfer QRIS.\n\n` +
    `Setelah admin memverifikasi, credit akan ditambahkan otomatis.</blockquote>`,
    [[{ text: "❌ Batalkan", data: "payment_cancel" }]]
  );
}

async function handlePaymentProof(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const state = userStates.get(userId);
  if (!state || state.step !== "WAITING_PAYMENT_PROOF") return false;

  const media = event.message.media;
  if (!media || !(media instanceof Api.MessageMediaPhoto)) {
    await sendHtml(chatId, `⚠️ <b>Kirim bukti berupa foto!</b>`);
    return true;
  }

  const paymentId = state.paymentId;
  const entry = paydb.get(paymentId);
  if (!entry) {
    userStates.delete(userId);
    await sendHtml(chatId, `❌ <b>Order tidak ditemukan.</b>`);
    return true;
  }

  // Download foto bukti
  const proofPath = tmpPath(`payment_${paymentId}_${Date.now()}.jpg`);
  await client.downloadMedia(event.message, { outputFile: proofPath });

  // Kirim ke channel admin
  const adminMsg = await client.sendMessage(CONFIG.CHANNEL_USERNAME, {
    message:
      `💳 <b>KONFIRMASI PEMBAYARAN</b>\n` +
      `────────────────────\n` +
      `<blockquote>` +
      `🧾 ID Order : <code>${entry.id}</code>\n` +
      `👤 User ID  : <code>${entry.userId}</code>\n` +
      `📦 Paket    : ${entry.package}\n` +
      `💳 Credit   : <b>${entry.credit}</b>\n` +
      `💰 Harga    : Rp ${entry.price.toLocaleString()}\n` +
      `📅 Waktu    : ${nowWib()}` +
      `</blockquote>`,
    file: proofPath,
    parseMode: "html",
    buttons: buildButtons([
      [{ text: "✅ Setujui", data: `pay_approve_${entry.id}` }],
      [{ text: "❌ Tolak", data: `pay_reject_${entry.id}` }]
    ])
  });

  // Hapus bukti dari disk
  if (fs.existsSync(proofPath)) fs.unlinkSync(proofPath);

  await sendHtml(chatId,
    `✅ <b>Bukti terkirim!</b>\n\n` +
    `<blockquote>Admin akan memproses pembayaran kamu.\n\n` +
    `Status akan diupdate otomatis.</blockquote>`,
    [[{ text: "🏠 Menu Utama", data: "start" }]]
  );

  userStates.delete(userId);
  return true;
}

// Admin approve/reject payment
async function handleAdminPaymentApprove(chatId, adminId, paymentId) {
  if (!isPrivileged(adminId)) { return sendHtml(chatId, "❌ Akses ditolak!"); }
  const entry = paydb.update(paymentId, { status: "approved" });
  if (!entry) {
    return sendHtml(chatId, `❌ <b>Order tidak ditemukan.</b>`);
  }
  // Tambahkan credit ke user
  const newCredit = cdb.addCredit(entry.userId, entry.credit, adminId);
  await sendHtml(chatId,
    `✅ <b>Pembayaran disetujui!</b>\n\n` +
    `<blockquote>🧾 Order: <code>${entry.id}</code>\n👤 User: <code>${entry.userId}</code>\n💳 Credit: <b>${entry.credit}</b> ditambahkan\n📊 Total: <b>${newCredit}</b></blockquote>`
  );
  // Beri tahu user
  try {
    await client.sendMessage(entry.userId, {
      message:
        `🎉 <b>PEMBAYARAN DISETUJUI!</b>\n` +
        `────────────────────\n\n` +
        `<blockquote>` +
        `🧾 Order: <code>${entry.id}</code>\n` +
        `💳 Credit: <b>${entry.credit}</b> ditambahkan\n` +
        `📊 Total credit: <b>${newCredit}</b>\n\n` +
        `Sekarang kamu bisa melakukan build! 🚀` +
        `</blockquote>`,
      parseMode: "html",
      buttons: buildButtons([[{ text: "🚀 Mulai Build", data: "build" }]])
    });
  } catch (_) {}
}

async function handleAdminPaymentReject(chatId, adminId, paymentId) {
  if (!isPrivileged(adminId)) { return sendHtml(chatId, "❌ Akses ditolak!"); }
  const entry = paydb.update(paymentId, { status: "rejected" });
  if (!entry) {
    return sendHtml(chatId, `❌ <b>Order tidak ditemukan.</b>`);
  }
  await sendHtml(chatId,
    `❌ <b>Pembayaran ditolak.</b>\n\n` +
    `<blockquote>🧾 Order: <code>${entry.id}</code>\n👤 User: <code>${entry.userId}</code></blockquote>`
  );
  try {
    await client.sendMessage(entry.userId, {
      message:
        `❌ <b>PEMBAYARAN DITOLAK</b>\n` +
        `────────────────────\n\n` +
        `<blockquote>` +
        `🧾 Order: <code>${entry.id}</code>\n` +
        `💳 Credit: <b>${entry.credit}</b> tidak ditambahkan.\n\n` +
        `Silakan cek kembali bukti pembayaran atau hubungi admin.\n` +
        `Jika sudah benar, kirim ulang bukti.` +
        `</blockquote>`,
      parseMode: "html"
    });
  } catch (_) {}
}

async function handleAdminPaymentList(chatId, adminId, editId = null) {
  if (!isPrivileged(adminId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  const pendings = paydb.getPending();
  let text = `💳 <b>PENDING PAYMENTS (${pendings.length})</b>\n────────────────────\n\n`;
  if (pendings.length === 0) {
    text += `<i>Tidak ada pending payment.</i>`;
  } else {
    pendings.forEach((p, i) => {
      text +=
        `${i+1}. 🧾 <b>${p.package}</b>\n` +
        `<blockquote>` +
        `🆔 Order: <code>${p.id}</code>\n` +
        `👤 User: <code>${p.userId}</code>\n` +
        `💳 Credit: ${p.credit}\n` +
        `💰 Harga: Rp ${p.price.toLocaleString()}\n` +
        `📅 Dibuat: ${fmtDateTime(p.createdAt)}\n` +
        `Status: <b>⏳ Pending</b>` +
        `</blockquote>\n`;
    });
  }
  const btns = [[{ text: "◀ Admin Panel", data: "admin_panel" }]];
  if (editId) {
    await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" });
  } else {
    await sendHtml(chatId, text, btns);
  }
}

// ─── LIST USERS (inline pagination) ──────────────────────────────────────
async function handleListUsers(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }

  const all      = db.getAllUsers();
  const perPage  = 8;
  const total    = Math.max(1, Math.ceil(all.length / perPage));
  page           = Math.min(Math.max(1, page), total);
  const slice    = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `<b>🔥 DAFTAR USER (${all.length})</b>\n` +
    `────────────────────\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  slice.forEach((u, i) => {
    const role    = roleTag(u.userId);
    const isBan   = bdb.isBanned(u.userId);
    const credit  = isCreditExempt(u.userId) ? "∞" : String(cdb.getCredit(u.userId));
    text +=
      `<b>${(page - 1) * perPage + i + 1}. ${role}${isBan ? " 🚫" : ""}</b>\n` +
      `<blockquote>` +
      `🆔 ID       : <code>${u.userId}</code>\n` +
      `👤 Nama     : ${u.name || "Unknown"}\n` +
      `🌐 Username : ${u.username || "—"}\n` +
      `💳 Credit   : <code>${credit}</code>\n` +
      `📅 Join     : ${fmtDate(u.joinedAt)}` +
      `</blockquote>\n`;
  });

  const nav = [];
  if (page > 1)    nav.push({ text: "◀️ Prev", data: `listusers_page_${page - 1}` });
  nav.push({ text: `📄 ${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next ▶️", data: `listusers_page_${page + 1}` });

  const btns = [
    nav,
    [{ text: "🔍 Cari User", data: "admin_search_user" }, { text: "📤 Export", data: "admin_export_users" }],
    [{ text: "◀ Admin Panel", data: "admin_panel" }],
  ];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── LIST RESELLERS (inline pagination) ──────────────────────────────────
async function handleListResellers(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }

  const all     = rdb.all();
  const perPage = 8;
  const total   = Math.max(1, Math.ceil(all.length / perPage));
  page          = Math.min(Math.max(1, page), total);
  const slice   = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `<b>🤝 DAFTAR RESELLER (${all.length})</b>\n` +
    `────────────────────\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  if (all.length === 0) {
    text += `<i>Belum ada reseller yang terdaftar.</i>`;
  } else {
    slice.forEach((r, i) => {
      text +=
        `<b>${(page - 1) * perPage + i + 1}. 🤝 RESELLER</b>\n` +
        `<blockquote>` +
        `🆔 ID          : <code>${r.userId}</code>\n` +
        `🌐 Username    : ${r.username || "—"}\n` +
        `📅 Ditambahkan : ${fmtDate(r.addedAt)}\n` +
        `🎯 Priority    : Level 2` +
        `</blockquote>\n`;
    });
  }

  const nav = [];
  if (page > 1)    nav.push({ text: "◀️ Prev", data: `listresellers_page_${page - 1}` });
  nav.push({ text: `📄 ${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next ▶️", data: `listresellers_page_${page + 1}` });

  const btns = [nav, [{ text: "◀ Admin Panel", data: "admin_panel" }]];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── BUILD HISTORY (inline pagination) ──────────────────────────────────
async function handleBuildHistory(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }

  const all     = hdb.all();
  const perPage = 6;
  const total   = Math.max(1, Math.ceil(all.length / perPage));
  page          = Math.min(Math.max(1, page), total);
  const slice   = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `<b>📋 RIWAYAT BUILD (${all.length})</b>\n` +
    `────────────────────\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  if (all.length === 0) {
    text += `<i>Belum ada riwayat build.</i>`;
  } else {
    slice.forEach((h, i) => {
      const statusIcon = h.status === "success" ? "✅" : h.status === "timeout" ? "⏱️" : "❌";
      text +=
        `<b>${(page - 1) * perPage + i + 1}. ${statusIcon} ${h.status.toUpperCase()}</b>\n` +
        `<blockquote>` +
        `👤 User    : ${h.userName || `ID:${h.userId}`}\n` +
        `📦 Project : <code>${h.project || "—"}</code>\n` +
        `🔧 Mode    : ${h.mode || "—"}\n` +
        (h.apkSize  ? `💾 APK     : <code>${h.apkSize} MB</code>\n` : "") +
        (h.duration ? `⏱ Durasi  : <code>${formatDuration(h.duration)}</code>\n` : "") +
        `📅 Waktu   : ${fmtDateTime(h.at)}` +
        `</blockquote>\n`;
    });
  }

  const cs   = db.getStats();
  const tot  = cs.success + cs.failed;
  const rate = tot > 0 ? ((cs.success / tot) * 100).toFixed(1) : "0.0";
  text +=
    `\n<blockquote>` +
    `✅ Total Sukses : <b>${cs.success}</b>\n` +
    `❌ Total Gagal  : <b>${cs.failed}</b>\n` +
    `📈 Success Rate : <b>${rate}%</b>` +
    `</blockquote>`;

  const nav = [];
  if (page > 1)    nav.push({ text: "◀️ Prev", data: `buildhistory_page_${page - 1}` });
  nav.push({ text: `📄 ${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next ▶️", data: `buildhistory_page_${page + 1}` });

  const btns = [nav, [{ text: "◀ Admin Panel", data: "admin_panel" }]];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── SEARCH USER ──────────────────────────────────────────────────────────
async function handleSearchUser(chatId, userId, query) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!query) {
    await sendHtml(chatId,
      `🔍 <b>Cari User</b>\n\n` +
      `<blockquote>Gunakan:\n<code>/searchuser 123456789</code>\n<code>/searchuser @username</code>\n<code>/searchuser nama</code></blockquote>`
    );
    return;
  }
  const results = db.searchUsers(query);
  if (results.length === 0) {
    await sendHtml(chatId,
      `🔍 <b>Hasil Pencarian</b>\n\n<blockquote>Tidak ada user cocok dengan: <code>${query}</code></blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
    return;
  }
  let text = `🔍 <b>Hasil Pencarian "${query}" (${results.length})</b>\n────────────────────\n\n`;
  results.slice(0, 10).forEach(u => {
    text +=
      `<b>${roleTag(u.userId)}${bdb.isBanned(u.userId) ? " 🚫" : ""}</b>\n` +
      `<blockquote>` +
      `🆔 ID       : <code>${u.userId}</code>\n` +
      `👤 Nama     : ${u.name || "Unknown"}\n` +
      `🌐 Username : ${u.username || "—"}\n` +
      `📅 Join     : ${fmtDate(u.joinedAt)}` +
      `</blockquote>\n`;
  });
  if (results.length > 10) text += `\n<i>+${results.length - 10} hasil lainnya</i>`;
  await sendHtml(chatId, text, [[{ text: "◀ Admin Panel", data: "admin_panel" }]]);
}

// ─── USER INFO ─────────────────────────────────────────────────────────────
async function handleUserInfo(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!targetId) {
    await sendHtml(chatId,
      `ℹ️ <b>Info User</b>\n\n<blockquote>Gunakan: <code>/userinfo 123456789</code></blockquote>`
    );
    return;
  }
  const num  = Number(targetId);
  const u    = db.getUserById(num);
  if (!u) { await sendHtml(chatId, `❌ <b>User ID <code>${num}</code> tidak ditemukan!</b>`); return; }

  const isRes = rdb.isReseller(num);
  const isBan = bdb.isBanned(num);
  const ban   = isBan ? bdb.getInfo(num) : null;
  const job   = getUserJob(num);

  let tgInfo = "—";
  try {
    const e = await client.getEntity(num);
    tgInfo  = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "—";
  } catch (_) {}

  const creditInfo = isCreditExempt(num) ? "∞ (Unlimited)" : String(cdb.getCredit(num));
  const isPrem = pdb.isPremium(num);
  const premInfo   = isPrem ? "⭐ Ya (Unlimited)" : "—";
  const text =
    `ℹ️ <b>INFO USER</b>\n` +
    `────────────────────\n` +
    `<blockquote>` +
    `🆔 ID           : <code>${num}</code>\n` +
    `👤 Nama (DB)    : ${u.name || "Unknown"}\n` +
    `👤 Nama (TG)    : ${tgInfo}\n` +
    `🌐 Username     : ${u.username || "—"}\n` +
    `🏅 Role         : ${roleTag(num)}\n` +
    `💳 Credit       : <b>${creditInfo}</b>\n` +
    `📅 Join         : ${fmtDateTime(u.joinedAt)}\n` +
    `⏰ Last Active  : ${fmtDateTime(u.lastActive)}\n` +
    `🤝 Reseller     : ${isRes ? "✅ Ya" : "❌ Tidak"}\n` +
    `⭐ Premium      : ${premInfo}\n` +
    `🚫 Status Ban   : ${isBan ? `🔴 Dibanned\n📋 Alasan: ${ban?.reason || "—"}\n📅 Dibanned: ${fmtDate(ban?.bannedAt)}` : "🟢 Normal"}\n` +
    `⚙️ Build Aktif  : ${job ? `✅ ${statusLabel(job.status)}` : "❌ Tidak ada"}` +
    `</blockquote>`;

  const btns = [
    isRes
      ? [{ text: "➖ Remove Reseller", data: `adm_rm_reseller_${num}` }]
      : [{ text: "➕ Add Reseller", data: `adm_add_reseller_${num}` }],
    isPrem
      ? [{ text: "➖ Remove Premium", data: `adm_rm_premium_${num}` }]
      : [{ text: "⭐ Add Premium", data: `adm_add_premium_${num}` }],
    isBan
      ? [{ text: "✅ Unban User", data: `adm_unban_${num}` }]
      : [{ text: "🚫 Ban User", data: `adm_ban_${num}` }],
    [{ text: "◀ Admin Panel", data: "admin_panel" }],
  ];

  await sendHtml(chatId, text, btns);
}

// ─── BAN / UNBAN ──────────────────────────────────────────────────────────
async function handleBanUser(chatId, userId, args) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!args) {
    await sendHtml(chatId, `🚫 <b>Ban User</b>\n\n<blockquote>Gunakan: <code>/banuser 123456789 alasan ban</code></blockquote>`);
    return;
  }
  const parts  = args.trim().split(/\s+/);
  const num    = Number(parts[0]);
  const reason = parts.slice(1).join(" ") || "Melanggar ketentuan";
  if (isNaN(num))     { await sendHtml(chatId, "❌ ID tidak valid!"); return; }
  if (isOwner(num))   { await sendHtml(chatId, "❌ Tidak bisa ban Owner!"); return; }
  if (bdb.ban(num, reason, userId)) {
    await sendHtml(chatId,
      `🚫 <b>User Dibanned!</b>\n\n` +
      `<blockquote>🆔 ID     : <code>${num}</code>\n📋 Alasan : ${reason}</blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
    try {
      await client.sendMessage(num, {
        message: `🚫 **AKUN ANDA DIBANNED**\n\nKamu tidak bisa menggunakan bot ini.\n\n📋 Alasan: ${reason}\n\nHubungi admin jika ini kesalahan.`,
        parseMode: "md"
      });
    } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ User ID <code>${num}</code> sudah dalam status ban.`);
  }
}

async function handleUnbanUser(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!targetId) {
    await sendHtml(chatId, `✅ <b>Unban User</b>\n\n<blockquote>Gunakan: <code>/unbanuser 123456789</code></blockquote>`);
    return;
  }
  const num = Number(targetId);
  if (bdb.unban(num)) {
    await sendHtml(chatId,
      `✅ <b>User Diunban!</b>\n\n<blockquote>🆔 ID: <code>${num}</code></blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
    try {
      await client.sendMessage(num, {
        message: `✅ **AKSES DIKEMBALIKAN**\n\nAkun kamu telah diunban. Kamu bisa menggunakan bot ini kembali.`,
        parseMode: "md"
      });
    } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ User ID <code>${num}</code> tidak sedang dalam status ban.`);
  }
}

// ─── KILL BUILD ────────────────────────────────────────────────────────────
async function handleListBuildsForKill(chatId, userId, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  const jobs = getSortedActiveJobs();

  let text =
    `💀 <b>FORCE KILL BUILD</b>\n` +
    `────────────────────\n\n`;

  if (jobs.length === 0) {
    text += `<i>Tidak ada build aktif saat ini.</i>`;
    const btns = [[{ text: "◀ Admin Panel", data: "admin_panel" }]];
    editId
      ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
      : await sendHtml(chatId, text, btns);
    return;
  }

  text += `<i>Pilih build yang ingin dihentikan paksa:</i>\n\n`;
  jobs.forEach((j, i) => {
    const usr = j.fullName && j.fullName !== "Unknown User" ? j.fullName : (j.username ? `@${j.username}` : `User_${j.userId}`);
    text +=
      `${i + 1}. <b>${roleTag(j.userId)}</b> — ${usr}\n` +
      `<blockquote>Status: ${statusLabel(j.status)}  |  ${formatDuration(elapsedSec(j.updatedAt))}</blockquote>\n`;
  });

  const btns = [
    ...jobs.map(j => {
      const usr = j.fullName && j.fullName !== "Unknown User" ? j.fullName.split(" ")[0] : (j.username || `U${j.userId}`);
      return [{ text: `💀 Kill: ${usr}`, data: `kill_build_${j.userId}` }];
    }),
    [{ text: "◀ Admin Panel", data: "admin_panel" }],
  ];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── DELETE USER / EXPORT / DM ──────────────────────────────────────────
async function handleDeleteUser(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!targetId) { await sendHtml(chatId, `🗑️ <b>Hapus User</b>\n\n<blockquote>Gunakan: <code>/deleteuser 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (isNaN(num))   { await sendHtml(chatId, "❌ ID tidak valid!"); return; }
  if (isOwner(num)) { await sendHtml(chatId, "❌ Tidak bisa menghapus Owner!"); return; }
  const u = db.getUserById(num);
  if (!u) { await sendHtml(chatId, `❌ User ID <code>${num}</code> tidak ditemukan.`); return; }
  db.deleteUser(num);
  rdb.remove(num);
  await sendHtml(chatId,
    `✅ <b>User Dihapus!</b>\n\n<blockquote>🆔 ID: <code>${num}</code>\n👤 Nama: ${u.name || "Unknown"}</blockquote>`,
    [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
  );
}

async function handleExportUsers(chatId, userId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  const all  = db.getAllUsers();
  const res  = rdb.all();
  const ban  = bdb.all();
  const hdrs = ["No","User ID","Nama","Username","Role","Reseller","Banned","Join Date","Last Active"];
  const rows = all.map((u, i) => {
    const isRes = res.some(r => r.userId === u.userId);
    const isBan = ban.some(b => b.userId === u.userId);
    const role  = isOwner(u.userId) ? "OWNER" : isRes ? "RESELLER" : isAdmin(u.userId) ? "ADMIN" : "USER";
    return [i + 1, u.userId, u.name || "Unknown", u.username || "-", role, isRes ? "Ya" : "Tidak", isBan ? "Ya" : "Tidak", fmtDate(u.joinedAt), fmtDate(u.lastActive)];
  });
  const csv     = [hdrs, ...rows].map(r => r.join(",")).join("\n");
  const csvPath = tmpPath(`users_export_${Date.now()}.csv`);
  fs.writeFileSync(csvPath, csv, "utf-8");
  try {
    await client.sendFile(chatId, {
      file: csvPath,
      caption:
        `📤 <b>Export Database User</b>\n\n` +
        `<blockquote>📊 Total User    : ${all.length}\n🤝 Total Reseller: ${res.length}\n🚫 Total Banned  : ${ban.length}\n📅 Diekspor      : ${nowWib()}</blockquote>`,
      parseMode: "html",
      forceDocument: true,
    });
    if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
  } catch (e) {
    if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
    await sendHtml(chatId, `❌ Gagal export: <code>${e.message}</code>`);
  }
}

async function handleDmUser(chatId, userId, args) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!args) { await sendHtml(chatId, `📣 <b>Kirim DM ke User</b>\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan kamu</code></blockquote>`); return; }
  const parts = args.trim().split(/\s+/);
  const num   = Number(parts[0]);
  const msg   = parts.slice(1).join(" ");
  if (isNaN(num) || !msg) { await sendHtml(chatId, `❌ Format salah!\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan</code></blockquote>`); return; }
  try {
    await client.sendMessage(num, { message: msg, parseMode: "md" });
    await sendHtml(chatId,
      `✅ <b>Pesan Terkirim!</b>\n\n<blockquote>🆔 Ke: <code>${num}</code>\n💬 Pesan: ${msg}</blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
  } catch (e) {
    await sendHtml(chatId, `❌ Gagal kirim: <code>${e.message}</code>`);
  }
}

// ─── CALLBACK ──────────────────────────────────────────────────────────────
// ─── OWNER PANEL ──────────────────────────────────────────────────────────
async function showOwnerPanel(chatId, userId, msgId = null) {
  if (!isOwner(userId)) { await sendHtml(chatId, "❌ Hanya Owner!"); return; }
  const stats  = db.getStats();
  const total  = stats.success + stats.failed;
  const rate   = total > 0 ? ((stats.success / total) * 100).toFixed(1) : "0.0";
  const allC   = cdb.all();
  const totalC = allC.reduce((s, c) => s + c.credit, 0);
  const ch     = renderChance(buildChanceRate());

  const text =
    `👑 <b>OWNER PANEL</b>\n────────────────────\n\n` +
    `<blockquote>` +
    `🔥 Total User    : <b>${db.getAllUsers().length}</b>\n` +
    `🤝 Reseller      : <b>${rdb.all().length}</b>\n` +
    `🚫 Banned        : <b>${bdb.all().length}</b>\n` +
    `⚙️ Build Aktif   : <b>${getActiveJobs().length}</b>\n` +
    `✅ Build Sukses  : <b>${stats.success}</b>\n` +
    `❌ Build Gagal   : <b>${stats.failed}</b>\n` +
    `📈 Success Rate  : <b>${rate}%</b>\n` +
    `💰 Total Credit  : <b>${totalC}</b> beredar\n` +
    `🛠️ Maintenance  : <b>${mdb.isEnabled() ? "🔴 ON" : "🟢 OFF"}</b>` +
    `</blockquote>\n\n` +
    `<b>📊 Chance Build:</b>\n` +
    `<blockquote>${renderChanceFull(ch.rate)}</blockquote>`;

  const btns = [
    [{ text: "🔥 Kelola User",        data: "listusers_page_1"      }, { text: "🤝 Kelola Reseller",  data: "listresellers_page_1"  }],
    [{ text: "⭐ Add Premium",         data: "owner_add_premium"     }, { text: "⭐ List Premium",     data: "owner_list_premium"    }],
    [{ text: "💳 Kelola Credit",       data: "admin_credit_panel"    }, { text: "🎁 Weekly Manual",   data: "owner_weekly_all"      }],
    [{ text: "➕ Add Admin",           data: "owner_add_admin_info"  }, { text: "📋 List Admin",      data: "owner_list_admins"     }],
    [{ text: "🚫 Ban User",            data: "admin_ban_user"       }, { text: "✅ Unban User",       data: "admin_unban_user"     }],
    [{ text: "📣 Broadcast",           data: "owner_broadcast_info" }, { text: "📣 DM ke User",       data: "admin_dm_user"        }],
    [{ text: "💀 Kill Build",          data: "admin_list_builds"    }, { text: "📋 Build History",    data: "buildhistory_page_1"  }],
    [{ text: "📤 Export Users",        data: "admin_export_users"   }, { text: "🔍 Cek User/Profil",  data: "cek_user"             }],
    [{ text: `🛠️ Maintenance ${mdb.isEnabled() ? "OFF" : "ON"}`, data: "admin_toggle_maint" }, { text: "🔄 Reset Stats", data: "admin_reset_stats" }],
    [{ text: "💳 Pending Payment",     data: "admin_payments"        }, { text: "🏠 Menu Utama",       data: "start"                }],
    // Fitur owner untuk QRIS
    [{ text: "📸 Set QRIS",           data: "owner_set_qris"       }, { text: "📝 Set Payment Info", data: "owner_set_payment_info" }],
  ];

  msgId
    ? await client.editMessage(chatId, { message: msgId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── BUILD SPEED ──────────────────────────────────────────────────────────
async function handleBuildSpeed(chatId, userId, msgId = null) {
  const history = hdb.all();
  const successes = history.filter(h => h.status === "success");
  const total = successes.length;
  let avgDuration = 0, avgSpeed = 0;
  if (total > 0) {
    const totalDur = successes.reduce((s, h) => s + (h.duration || 0), 0);
    avgDuration = totalDur / total;
    const totalSize = successes.reduce((s, h) => s + (parseFloat(h.apkSize) || 0), 0);
    avgSpeed = totalSize / totalDur; // MB/s
  }
  const now = Date.now();
  const last24h = history.filter(h => (now - new Date(h.at).getTime()) < 24 * 60 * 60 * 1000);
  const builds24h = last24h.length;
  const success24h = last24h.filter(h => h.status === "success").length;
  const active = getActiveJobs().length;
  const ch = renderChance(buildChanceRate());

  const text =
    `📊 <b>BUILD STATISTICS & SPEED</b>\n` +
    `────────────────────\n\n` +
    `<blockquote>` +
    `📈 Total Builds      : <b>${history.length}</b>\n` +
    `✅ Sukses            : <b>${successes.length}</b>\n` +
    `⏱ Rata-rata Durasi  : <b>${avgDuration ? formatDuration(avgDuration) : "—"}</b>\n` +
    `💾 Rata-rata Kecepatan APK : <b>${avgSpeed ? avgSpeed.toFixed(2) + " MB/s" : "—"}</b>\n` +
    `📊 Build 24 jam      : <b>${builds24h}</b> (${success24h} sukses)\n` +
    `⚙️ Build Aktif       : <b>${active}</b>\n` +
    `📊 Chance Berhasil   : <b>${ch.rate}%</b>\n` +
    `</blockquote>\n\n` +
    `<blockquote>` +
    `📈 <b>Live Build Speed</b>\n` +
    `Kecepatan upload/download akan muncul di status build.\n` +
    `</blockquote>`;

  const btns = [[{ text: "🔄 Refresh", data: "buildspeed" }, { text: "🏠 Menu Utama", data: "start" }]];
  if (msgId) await client.editMessage(chatId, { message: msgId, text, buttons: buildButtons(btns), parseMode: "html" });
  else await sendHtml(chatId, text, btns);
}

// ─── WEEKLY CREDIT CLAIM ──────────────────────────────────────────────────
const WEEKLY_CREDIT = 5;

async function handleWeeklyClaim(chatId, userId, msgId = null) {
  if (isCreditExempt(userId)) {
    const txt =
      `<tg-emoji emoji-id="6206312014273321181">⭐️</tg-emoji> <b>Weekly Credit</b>\n────────────────────\n\n` +
      `<blockquote>Kamu memiliki akses <b>${roleTag(userId)}</b> dengan credit <b>Unlimited</b>.\n\nFitur weekly claim tidak berlaku untuk role kamu.</blockquote>`;
    return msgId
      ? await editHtml(chatId, msgId, txt, [[{ text: "🏠 Menu Utama", data: "start" }]])
      : await sendHtml(chatId, txt, [[{ text: "🏠 Menu Utama", data: "start" }]]);
  }

  const canClaim = wdb.canClaim(userId);
  const curCredit = cdb.getCredit(userId);

  if (!canClaim) {
    const nextStr = wdb.nextClaimStr(userId);
    const txt =
      `⏳ <b>Weekly Credit Belum Tersedia</b>\n────────────────────\n\n` +
      `<blockquote>` +
      `💳 Credit Sekarang : <b>${curCredit}</b>\n` +
      `🎁 Bonus Mingguan  : <b>${WEEKLY_CREDIT} credit</b>\n` +
      `⏰ Bisa Claim Lagi : <b>${nextStr}</b>\n\n` +
      `Credit mingguan bisa di-claim setiap <b>7 hari sekali</b>.` +
      `</blockquote>`;
    return msgId
      ? await editHtml(chatId, msgId, txt, [[{ text: "🏠 Menu Utama", data: "start" }]])
      : await sendHtml(chatId, txt, [[{ text: "🏠 Menu Utama", data: "start" }]]);
  }

  wdb.setClaim(userId);
  const newTotal = cdb.addCredit(userId, WEEKLY_CREDIT, "weekly_system");

  const txt =
    `<tg-emoji emoji-id="6206378324273403309">🎉</tg-emoji> <b>Weekly Credit Berhasil Diklaim!</b>\n────────────────────\n\n` +
    `<blockquote>` +
    `<tg-emoji emoji-id="4974414728337032308">🎁</tg-emoji> Bonus Diterima  : <b>+${WEEKLY_CREDIT} credit</b>\n` +
    `<tg-emoji emoji-id="4965670789102699620">🌟</tg-emoji> Total Credit    : <b>${newTotal}</b>\n` +
    `<tg-emoji emoji-id="6206225311768516593">📉</tg-emoji> Claim Berikutnya: <b>7 hari lagi</b>\n\n` +
    `Gunakan credit ini untuk build APK Flutter! 🚀` +
    `</blockquote>`;
  return msgId
    ? await editHtml(chatId, msgId, txt, [[{ text: "🚀 Build Sekarang", data: "build" }, { text: "🏠 Menu Utama", data: "start" }]])
    : await sendHtml(chatId, txt, [[{ text: "🚀 Build Sekarang", data: "build" }, { text: "🏠 Menu Utama", data: "start" }]]);
}

// ─── AUTO WEEKLY CREDIT SCHEDULER ────────────────────────────────────────
async function runWeeklyAutoCredit() {
  const users = db.getAllUsers();
  let given = 0;
  for (const u of users) {
    const id = u.userId;
    if (isCreditExempt(id)) continue;
    if (!wdb.canClaim(id))  continue;
    wdb.setClaim(id);
    const newTotal = cdb.addCredit(id, WEEKLY_CREDIT, "weekly_auto");
    given++;
    try {
      await client.sendMessage(id, {
        message:
          `🎁 <b>CREDIT MINGGUAN OTOMATIS!</b>\n────────────────────\n\n` +
          `<blockquote>` +
          `Kamu mendapat <b>${WEEKLY_CREDIT} credit gratis</b> mingguan!\n\n` +
          `💳 Total Credit : <b>${newTotal}</b>\n` +
          `⚡ Gunakan untuk build APK Flutter atau Web to APK.\n\n` +
          `Credit baru akan muncul lagi <b>7 hari kemudian</b>.` +
          `</blockquote>`,
        parseMode: "html",
        buttons: buildButtons([[{ text: "🚀 Build Sekarang!", data: "build" }]]),
      });
    } catch (_) {}
    await sleep(300);
  }
  console.log(`[WeeklyCredit] Auto-distributed ${WEEKLY_CREDIT} credit to ${given}/${users.length} users.`);
  try {
    await client.sendMessage(CONFIG.OWNER_ID, {
      message:
        `📊 <b>LAPORAN WEEKLY CREDIT</b>\n────────────────────\n\n` +
        `<blockquote>` +
        `🎁 Credit dibagikan  : <b>${WEEKLY_CREDIT}/user</b>\n` +
        `🔥 Penerima          : <b>${given} user</b>\n` +
        `📊 Total user skip   : <b>${users.length - given}</b> (exempt/belum waktunya)\n` +
        `⏰ Waktu             : ${nowWib()} WIB` +
        `</blockquote>`,
      parseMode: "html",
    });
  } catch (_) {}
}

// ─── DC DATACENTER MAP ────────────────────────────────────────────────────
const DC_INFO = {
  1: { name: "MIA, Miami USA",       flag: "🇺🇸", loc: "Miami, Florida" },
  2: { name: "AMS, Amsterdam NL",    flag: "🇳🇱", loc: "Amsterdam, Netherlands" },
  3: { name: "MIA, Miami USA",       flag: "🇺🇸", loc: "Miami, Florida" },
  4: { name: "AMS, Amsterdam NL",    flag: "🇳🇱", loc: "Amsterdam, Netherlands" },
  5: { name: "SIN, Singapore",       flag: "🇸🇬", loc: "Singapore" },
};

// ─── CEK USER ID / PROFIL ─────────────────────────────────────────────────
async function handleCekUser(chatId, userId, query) {
  if (!query) {
    userStates.set(userId, { step: "WAITING_CEK_USER" });
    return await sendHtml(chatId,
      `🔍 <b>Cek User Telegram</b>\n────────────────────\n\n` +
      `<blockquote>Kirim salah satu:\n\n` +
      `• <b>ID</b>: <code>123456789</code>\n` +
      `• <b>Username</b>: <code>@username</code>\n` +
      `• <b>Username</b>: <code>username</code></blockquote>`,
      [[{ text: "❌ Batal", data: "start" }]]
    );
  }
  await _doCheckUser(chatId, userId, query);
}

async function _doCheckUser(chatId, userId, query) {
  const m = await sendHtml(chatId, `🔍 <b>Mencari profil...</b>\n\n<blockquote>Query: <code>${query}</code></blockquote>`);
  try {
    let target;
    const clean = String(query).replace("@","").trim();
    const asNum = parseInt(clean);
    if (!isNaN(asNum) && String(asNum) === clean) {
      try { target = await client.getEntity(asNum); } catch(_) {}
    }
    if (!target) {
      try { target = await client.getEntity(clean); } catch(_) {}
    }
    if (!target) throw new Error("User tidak ditemukan. Pastikan username/ID benar dan akun pernah berinteraksi.");

    const id        = Number(target.id);
    const firstName = target.firstName || "";
    const lastName  = target.lastName  || "";
    const fullName  = [firstName, lastName].filter(Boolean).join(" ") || "—";
    const username  = target.username ? `@${target.username}` : "—";
    const isBot     = target.bot ? "🤖 Ya" : "👤 Tidak";
    const verified  = target.verified  ? "✅ Verified" : "❌ Tidak";
    const premium   = target.premium   ? "⭐ Premium" : "—";
    const dcId      = target.photo?.dcId || null;
    const dc        = dcId ? DC_INFO[dcId] : null;
    const dcText    = dc  ? `DC${dcId} — ${dc.flag} ${dc.name}` : (dcId ? `DC${dcId}` : "—");
    const dcLoc     = dc  ? dc.loc : "";
    const phone     = target.phone ? `+${target.phone}` : "—";

    const roleInBot = isOwner(id) ? "👑 OWNER" : isAdmin(id) ? "🔑 ADMIN" : rdb.isReseller(id) ? "🤝 RESELLER" : "👤 USER";
    const creditInfo = isCreditExempt(id) ? "∞ (Unlimited)" : `${cdb.getCredit(id)} credit`;
    const isBanned   = bdb.isBanned(id) ? "🚫 Dibanned" : "🟢 Normal";
    const isBuilding = isUserBuilding(id) ? "⚙️ Sedang Build" : "—";

    const dbUser = db.getUserById(id);

    const text =
      `👤 <b>PROFIL TELEGRAM</b>\n────────────────────\n\n` +
      `<blockquote>` +
      `🆔 User ID    : <code>${id}</code>\n` +
      `👤 Nama       : <b>${fullName}</b>\n` +
      `🌐 Username   : ${username}\n` +
      `📱 Telepon    : <code>${phone}</code>\n` +
      `🤖 Bot        : ${isBot}\n` +
      `✅ Verified   : ${verified}\n` +
      `⭐ Premium    : ${premium}` +
      `</blockquote>\n\n` +
      `<blockquote>` +
      `📡 DC Server  : <b>${dcText}</b>\n` +
      (dcLoc ? `🌍 Lokasi DC  : <code>${dcLoc}</code>\n` : "") +
      `📅 Di Bot     : ${dbUser ? fmtDate(dbUser.joinedAt) : "Belum terdaftar"}\n` +
      `🏅 Role Bot   : <b>${roleInBot}</b>\n` +
      `💳 Credit     : <b>${creditInfo}</b>\n` +
      `🚫 Status     : ${isBanned}\n` +
      `⚙️ Build      : ${isBuilding}` +
      `</blockquote>`;

    try {
      const photos = await client.getProfilePhotos(target, { limit: 1 });
      if (photos && photos.length > 0) {
        const photoPath = tmpPath(`prof_${id}_${Date.now()}.jpg`);
        await client.downloadMedia(photos[0], { outputFile: photoPath });
        await client.deleteMessages(chatId, [m.id], { revoke: true }).catch(() => {});
        await client.sendFile(chatId, {
          file: photoPath, caption: text, parseMode: "html",
          buttons: buildButtons([[{ text: "🔍 Cek User Lain", data: "cek_user" }, { text: "🏠 Menu Utama", data: "start" }]]),
        });
        if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
        return;
      }
    } catch(_) {}

    await editHtml(chatId, m.id, text, [[{ text: "🔍 Cek User Lain", data: "cek_user" }, { text: "🏠 Menu Utama", data: "start" }]]);
  } catch(err) {
    await editHtml(chatId, m.id,
      `❌ <b>Gagal Menemukan User</b>\n\n<blockquote>${err.message}</blockquote>`,
      [[{ text: "🔍 Coba Lagi", data: "cek_user" }, { text: "🏠 Menu Utama", data: "start" }]]
    );
  }
}

// ─── CEK DC SERVER ─────────────────────────────────────────────────────────
async function handleCekDC(chatId, userId) {
  const ch = renderChance(buildChanceRate());
  const rows = Object.entries(DC_INFO).map(([id, dc]) => {
    const isGithub = id == 2 || id == 4;
    return `<b>DC${id}</b> ${dc.flag} — ${dc.name}\n<code>🌍 ${dc.loc}${isGithub ? " | 🔗 GitHub/Bot" : ""}</code>`;
  }).join("\n\n");

  await sendHtml(chatId,
    `🌐 <b>DATACENTER TELEGRAM</b>\n────────────────────\n\n` +
    `<blockquote>${rows}</blockquote>\n\n` +
    `<blockquote>` +
    `ℹ️ DC menunjukkan lokasi server penyimpanan akun Telegram.\n` +
    `📊 Build Chance: <code>${ch.bar}</code> ${ch.emoji} <b>${ch.rate}%</b>` +
    `</blockquote>`,
    [[{ text: "🔍 Cek User/DC", data: "cek_user" }, { text: "🏠 Menu Utama", data: "start" }]]
  );
}

async function handleCallback(event) {
  try {
    const data   = event.data.toString();
    const chatId = event.chatId;
    const userId = Number(event.senderId);
    const msgId  = event.messageId;

    // ── Payment callbacks ──────────────────────────────────────────────
    if (data.startsWith("payment_package_")) {
      await event.answer();
      return await handlePaymentPackage(chatId, userId, data);
    }
    if (data === "buy_credit") {
      await event.answer();
      return await handleBuyCredit(chatId, userId, msgId);
    }
    if (data.startsWith("payment_confirm_")) {
      const paymentId = data.replace("payment_confirm_", "");
      await event.answer();
      return await handlePaymentConfirm(chatId, userId, paymentId);
    }
    if (data === "payment_cancel") {
      userStates.delete(userId);
      await event.answer({ message: "Pesanan dibatalkan" });
      return await sendHtml(chatId, `✅ <b>Pesanan dibatalkan.</b>`, [[{ text: "🏠 Menu Utama", data: "start" }]]);
    }
    if (data.startsWith("pay_approve_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const paymentId = data.replace("pay_approve_", "");
      await event.answer({ message: "✅ Disetujui!" });
      await handleAdminPaymentApprove(chatId, userId, paymentId);
      await client.deleteMessages(chatId, [msgId], { revoke: true }).catch(()=>{});
      return;
    }
    if (data.startsWith("pay_reject_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const paymentId = data.replace("pay_reject_", "");
      await event.answer({ message: "❌ Ditolak!" });
      await handleAdminPaymentReject(chatId, userId, paymentId);
      await client.deleteMessages(chatId, [msgId], { revoke: true }).catch(()=>{});
      return;
    }
    if (data === "admin_payments") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer();
      return await handleAdminPaymentList(chatId, userId, msgId);
    }

    // ── Broadcast ──────────────────────────────────────────────────────
    if (data.startsWith("broadcast_approve_")) {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      try { await client.sendMessage(parseInt(data.split("_")[2]), { message: `✅ **Broadcast disetujui Owner!**`, parseMode: "md" }); } catch (_) {}
      return await event.answer({ message: "✅ Disetujui!" });
    }
    if (data.startsWith("broadcast_reject_")) {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      try { await client.sendMessage(parseInt(data.replace("broadcast_reject_", "")), { message: `❌ **Broadcast ditolak Owner!**`, parseMode: "md" }); } catch (_) {}
      return await event.answer({ message: "❌ Ditolak!" });
    }

    if (data === "noop") return await event.answer();

    // Pagination
    if (data.startsWith("listusers_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const page = parseInt(data.replace("listusers_page_", ""));
      await event.answer();
      return await handleListUsers(chatId, userId, page, msgId);
    }
    if (data.startsWith("listresellers_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const page = parseInt(data.replace("listresellers_page_", ""));
      await event.answer();
      return await handleListResellers(chatId, userId, page, msgId);
    }
    if (data.startsWith("buildhistory_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const page = parseInt(data.replace("buildhistory_page_", ""));
      await event.answer();
      return await handleBuildHistory(chatId, userId, page, msgId);
    }

    if (data.startsWith("kill_build_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("kill_build_", ""));
      const job = getUserJob(targetId);
      if (!job) return await event.answer({ message: "ℹ️ Build sudah selesai.", alert: true });
      removeUserJob(targetId);
      await event.answer({ message: `💀 Build user ${targetId} dihentikan!` });
      try { await client.sendMessage(job.chatId, { message: `⚠️ **Build kamu dihentikan paksa oleh admin.**`, parseMode: "md" }); } catch (_) {}
      return await handleListBuildsForKill(chatId, userId, msgId);
    }

    // Quick userinfo from button
    if (data.startsWith("adm_add_premium_")) {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await event.answer(); await handleAddPremium(chatId, userId, String(parseInt(data.replace("adm_add_premium_","")))); return;
    }
    if (data.startsWith("adm_rm_premium_")) {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await event.answer(); await handleRemovePremium(chatId, userId, parseInt(data.replace("adm_rm_premium_",""))); return;
    }
    if (data.startsWith("adm_add_reseller_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_add_reseller_", ""));
      await event.answer();
      await handleAddReseller(chatId, userId, targetId);
      return;
    }
    if (data.startsWith("adm_rm_reseller_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_rm_reseller_", ""));
      await event.answer();
      await handleRemoveReseller(chatId, userId, targetId);
      return;
    }
    if (data.startsWith("adm_ban_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_ban_", ""));
      await event.answer();
      await handleBanUser(chatId, userId, `${targetId} Via panel`);
      return;
    }
    if (data.startsWith("adm_unban_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_unban_", ""));
      await event.answer();
      await handleUnbanUser(chatId, userId, targetId);
      return;
    }

    // Report actions
    if (data === "user_start_lapor") {
      if (db.isReportBlocked(userId)) return event.answer({ message: "❌ Kamu diblokir dari fitur laporan.", alert: true });
      userStates.set(userId, { step: "WAITING_FOR_REASON" });
      await client.editMessage(chatId, {
        message: msgId,
        text: `📝 <b>MENU LAPORAN</b>\n\n<blockquote>Ketik alasan dan detail laporan kamu dengan jelas, lalu kirim lewat chat.\n\n⚠️ Laporan palsu akan menyebabkan akun diblokir.</blockquote>`,
        parseMode: "html",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]])
      });
      return await event.answer();
    }
    if (data === "user_cancel_lapor") {
      userStates.delete(userId);
      await client.editMessage(chatId, {
        message: msgId,
        text: `❌ <b>Laporan Dibatalkan</b>\n\n<blockquote>Proses laporan dihentikan.</blockquote>`,
        parseMode: "html",
        buttons: []
      });
      return await event.answer({ message: "Laporan dibatalkan" });
    }

    // Check credit
    if (data === "check_credit") {
      await event.answer();
      const exempt2 = isCreditExempt(userId);
      const cr      = exempt2 ? "∞" : String(cdb.getCredit(userId));
      const crNum   = exempt2 ? null : cdb.getCredit(userId);
      const role    = getRoleName(userId);
      const roleEmoji = { OWNER: "👑", ADMIN: "🔑", RESELLER: "🤝", USER: "👤" }[role] || "👤";
      const statusLine = exempt2
        ? `✅ <b>Build Unlimited</b> — Tidak perlu credit`
        : crNum > 0 ? `✅ <b>Siap Build!</b> — ${crNum} build tersisa` : `❌ <b>Credit Habis</b> — Beli via QRIS atau hubungi owner`;
      const ch2 = renderChance(buildChanceRate());
      await sendHtml(chatId,
        `💳 <b>INFO CREDIT KAMU</b>\n────────────────────\n\n` +
        `<blockquote>${roleEmoji} Role    : <b>${role}</b>\n👤 User ID : <code>${userId}</code>\n💳 Credit  : <b>${cr}</b>\n\n${statusLine}</blockquote>\n\n` +
        `<blockquote>📊 <b>Chance Build Sekarang:</b>\n` + renderChanceFull(ch2.rate) + `</blockquote>`,
        [[{ text: "🚀 Mulai Build", data: "build" }, { text: "💰 Beli Credit", data: "buy_credit" }, { text: "🏠 Menu Utama", data: "start" }]]
      );
      return;
    }

    // Credit panel
    if (data === "admin_credit_panel") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer(); return await showCreditPanel(chatId, userId, msgId);
    }
    if (data === "credit_add_info") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer();
      return await sendHtml(chatId, `➕ <b>Tambah Credit</b>\n\n<blockquote>Gunakan: <code>/addcredit &lt;userId&gt; &lt;jumlah&gt;</code>\n\nContoh: <code>/addcredit 123456789 10</code></blockquote>`, [[{ text: "◀ Kelola Credit", data: "admin_credit_panel" }]]);
    }
    if (data === "credit_reduce_info") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer();
      return await sendHtml(chatId, `➖ <b>Kurangi Credit</b>\n\n<blockquote>Gunakan: <code>/reducecredit &lt;userId&gt; &lt;jumlah&gt;</code>\n\nContoh: <code>/reducecredit 123456789 5</code></blockquote>`, [[{ text: "◀ Kelola Credit", data: "admin_credit_panel" }]]);
    }
    if (data === "credit_reset_info") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer();
      return await sendHtml(chatId, `🗑️ <b>Reset Credit</b>\n\n<blockquote>Gunakan: <code>/resetcredit &lt;userId&gt;</code>\n\nIni akan set credit user ke 0.</blockquote>`, [[{ text: "◀ Kelola Credit", data: "admin_credit_panel" }]]);
    }
    if (data === "credit_list") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer();
      const allC = cdb.all();
      if (!allC.length) return await sendHtml(chatId, `📋 <b>Daftar Credit</b>\n\n<blockquote>Belum ada user yang punya credit.</blockquote>`, [[{ text: "◀ Kelola Credit", data: "admin_credit_panel" }]]);
      const lines = allC.map((c, i) => `${i+1}. <code>${c.userId}</code> — 💳 <b>${c.credit}</b> credit`).join("\n");
      return await sendHtml(chatId, `📋 <b>Daftar Credit User</b>\n────────────────────\n\n<blockquote>${lines}</blockquote>\n\n<i>Total: ${allC.length} user punya credit</i>`, [[{ text: "◀ Kelola Credit", data: "admin_credit_panel" }]]);
    }

    // Owner panel
    if (data === "owner_panel") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await event.answer(); return await showOwnerPanel(chatId, userId, msgId);
    }
    if (data === "admin_panel") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer();
      if (isOwner(userId)) return await showOwnerPanel(chatId, userId, msgId);
      return await showAdminPanel(chatId, userId, msgId);
    }

    if (data === "owner_weekly_all") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await event.answer({ message: "🎁 Mendistribusikan weekly credit..." });
      await sendHtml(chatId, `⏳ <b>Distribusi Weekly Credit Dimulai...</b>\n\n<blockquote>Mengirim <b>${WEEKLY_CREDIT} credit</b> ke semua user eligible.\nBot akan DM tiap user yang mendapat credit.\nLaporan dikirim setelah selesai.</blockquote>`);
      runWeeklyAutoCredit().catch(console.error);
      return;
    }

    if (data === "owner_add_premium") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await event.answer();
      return await sendHtml(chatId,
        `⭐ <b>Tambah Premium</b>\n────────────────────\n\n<blockquote>Gunakan: <code>/addpremium 123456789 [catatan]</code>\n\nPremium = build unlimited tanpa potong credit.</blockquote>`,
        [[{ text: "◀ Owner Panel", data: "owner_panel" }]]
      );
    }
    if (data === "owner_list_premium") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await event.answer(); return await handleListPremium(chatId, userId, msgId);
    }
    if (data === "owner_list_admins") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await event.answer();
      const admins = CONFIG.ADMIN_IDS.filter(id => !isOwner(id));
      let text = `<b>🔑 DAFTAR ADMIN (${admins.length})</b>\n────────────────────\n\n`;
      if (!admins.length) { text += `<i>Belum ada admin yang dikonfigurasi.</i>\n\n<blockquote>Tambah Admin ID di <code>config.js</code> → <code>ADMIN_IDS</code></blockquote>`; }
      else { admins.forEach((id, i) => { const u = db.getUserById(id); text += `${i+1}. 🔑 <b>ADMIN</b>\n<blockquote>🆔 ID: <code>${id}</code>\n👤 Nama: ${u?.name||"Unknown"}\n🌐 Username: ${u?.username||"—"}\n💳 Credit: ∞ Unlimited</blockquote>\n`; }); }
      return await sendHtml(chatId, text, [[{ text: "◀ Owner Panel", data: "owner_panel" }]]);
    }
    if (data === "owner_add_admin_info") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await event.answer();
      return await sendHtml(chatId,
        `➕ <b>Tambah Admin</b>\n────────────────────\n\n` +
        `<blockquote>Admin dikonfigurasi melalui <b>config.js</b>:\n\n<code>ADMIN_IDS: ["123456789"]</code>\n\nRestart bot setelah mengubah.</blockquote>`,
        [[{ text: "◀ Owner Panel", data: "owner_panel" }]]
      );
    }
    if (data === "owner_broadcast_info") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await event.answer();
      return await sendHtml(chatId,
        `📣 <b>Cara Broadcast</b>\n────────────────────\n\n` +
        `<blockquote>Reply pesan yang ingin dikirim lalu ketik:\n\n<code>/broadcast</code>\n\nSupport teks & gambar/file.</blockquote>`,
        [[{ text: "◀ Owner Panel", data: "owner_panel" }]]
      );
    }

    // Owner set QRIS & payment info
    if (data === "owner_set_qris") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      userStates.set(userId, { step: "WAITING_QRIS" });
      await event.answer();
      return await sendHtml(chatId,
        `📸 <b>Set QRIS</b>\n────────────────────\n\n<blockquote>Kirim <b>foto QRIS</b> (format gambar).\n\nFoto ini akan ditampilkan saat user membeli credit.</blockquote>`,
        [[{ text: "❌ Batal", data: "cancel" }]]
      );
    }
    if (data === "owner_set_payment_info") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await event.answer();
      return await sendHtml(chatId,
        `📝 <b>Set Payment Info</b>\n────────────────────\n\n<blockquote>Gunakan: <code>/setpaymentinfo &lt;instruksi&gt;</code>\n\nContoh:\n<code>/setpaymentinfo Silakan transfer ke rekening BCA 123456789 a.n. Toko Kami</code></blockquote>`,
        [[{ text: "◀ Owner Panel", data: "owner_panel" }]]
      );
    }

    if (data === "admin_add_reseller") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `➕ <b>Tambah Reseller</b>\n\n<blockquote>Gunakan: <code>/addreseller 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_remove_reseller") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `➖ <b>Hapus Reseller</b>\n\n<blockquote>Gunakan: <code>/removereseller 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_search_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `🔍 <b>Cari User</b>\n\n<blockquote>Gunakan:\n<code>/searchuser 123456789</code>\n<code>/searchuser @username</code>\n<code>/searchuser nama</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_userinfo") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `ℹ️ <b>Info User</b>\n\n<blockquote>Gunakan: <code>/userinfo 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_ban_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `🚫 <b>Ban User</b>\n\n<blockquote>Gunakan: <code>/banuser 123456789 alasan</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_unban_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `✅ <b>Unban User</b>\n\n<blockquote>Gunakan: <code>/unbanuser 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_list_builds") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer();
      return await handleListBuildsForKill(chatId, userId, msgId);
    }
    if (data === "admin_export_users") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer({ message: "📤 Mengekspor..." });
      return await handleExportUsers(chatId, userId);
    }
    if (data === "admin_dm_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `📣 <b>Kirim DM ke User</b>\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan kamu</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_toggle_maint") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const now = mdb.toggle();
      await event.answer({ message: `🛠️ Maintenance ${now ? "AKTIF" : "NONAKTIF"}!` });
      return await showAdminPanel(chatId, userId, msgId);
    }
    if (data === "admin_reset_stats") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      db.resetStats();
      await event.answer({ message: "✅ Stats direset!" });
      return await showAdminPanel(chatId, userId, msgId);
    }

    if (data === "buildspeed") {
      await event.answer();
      return await handleBuildSpeed(chatId, userId, msgId);
    }

    // Report admin actions
    const isAdminAct = data.startsWith("adm_fix_") || data.startsWith("adm_blk_") || data.startsWith("adm_unblk_");
    if (isAdminAct) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      let origText = "Laporan User";
      try { const m = await client.getMessages(chatId, { ids: [msgId] }); origText = m[0]?.message || m[0]?.caption || origText; } catch (_) {}

      if (data.startsWith("adm_fix_")) {
        const tid = Number(data.replace("adm_fix_", ""));
        try {
          await client.sendMessage(tid, { message: `🎉 **LAPORAN SELESAI!**\n\nKendala yang kamu laporkan telah diperbaiki oleh admin. Terima kasih!`, parseMode: "md" });
          await event.answer({ message: "✅ User diberitahu!" });
        } catch (_) { await event.answer({ message: "⚠️ Gagal kirim DM!", alert: true }); }
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n🟢 **STATUS:** Selesai & user diberitahu.", parseMode: "md", buttons: buildButtons([[{ text: "🔒 Blokir", data: `adm_blk_${tid}` }]]) });
        return;
      }
      if (data.startsWith("adm_blk_")) {
        const tid = Number(data.replace("adm_blk_", ""));
        if (db.isReportBlocked(tid)) return await event.answer({ message: "ℹ️ Sudah diblokir.", alert: true });
        db.blockReportUser(tid);
        await event.answer({ message: `🔒 User ${tid} diblokir!` });
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n🔴 **STATUS:** User diblokir.", parseMode: "md", buttons: buildButtons([[{ text: "🔓 Unblokir", data: `adm_unblk_${tid}` }]]) });
        try { await client.sendMessage(tid, { message: `⚠️ **DIBLOKIR!**\n\nFitur laporan kamu dinonaktifkan.`, parseMode: "md" }); } catch (_) {}
        return;
      }
      if (data.startsWith("adm_unblk_")) {
        const tid = Number(data.replace("adm_unblk_", ""));
        if (!db.isReportBlocked(tid)) return await event.answer({ message: "ℹ️ Tidak dalam blokir.", alert: true });
        db.unblockReportUser(tid);
        await event.answer({ message: `🔓 User ${tid} diunblokir!` });
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n⚪ **STATUS:** Akses normal.", parseMode: "md", buttons: buildButtons([[{ text: "✅ Selesai", data: `adm_fix_${tid}` }, { text: "🔒 Blokir", data: `adm_blk_${tid}` }]]) });
        try { await client.sendMessage(tid, { message: `✅ **AKSES DIKEMBALIKAN!**\n\nFitur laporan kamu aktif kembali.`, parseMode: "md" }); } catch (_) {}
        return;
      }
    }

    // Check join
    if (data === "check_join") {
      const joined = await isJoinedChannel(userId);
      if (!joined) return event.answer({ message: "❌ Belum join semua channel!", alert: true });
      await event.answer({ message: "✅ Verifikasi berhasil!" });
      let firstName = "User";
      try { const e = await client.getEntity(userId); firstName = e?.firstName || "User"; } catch (_) {}
      return handleStart({ chatId, message: { getSender: async () => ({ id: userId, firstName, username: null }) } }, msgId);
    }

    await event.answer();

    // Main navigation
    if (data === "start") {
      return await handleStart({
        chatId,
        message: {
          getSender: async () => {
            try { const e = await client.getEntity(userId); return { id: userId, firstName: e?.firstName || "User", username: e?.username || null }; }
            catch (_) { return { id: userId, firstName: "User" }; }
          }
        }
      }, msgId);
    }
    if (data === "build")         return await handleBuild(chatId, userId, null,      msgId);
    if (data === "build_debug")   return await handleBuild(chatId, userId, "debug",   msgId);
    if (data === "build_release") return await handleBuild(chatId, userId, "release", msgId);
    if (data === "web2apk")       return await handleWeb2Apk(chatId, userId, msgId);
    if (data === "queue")         return await handleQueue(chatId, msgId);
    if (data === "help")          return await handleHelp(chatId, msgId);
    if (data === "status")        return await handleStatus(chatId, userId, msgId);
    if (data === "weekly_claim") {
      await event.answer();
      return await handleWeeklyClaim(chatId, userId, msgId);
    }
    if (data === "cek_user") {
      await event.answer();
      return await handleCekUser(chatId, userId, null);
    }
    if (data === "cek_dc") {
      await event.answer();
      return await handleCekDC(chatId, userId);
    }
    if (data === "cancel") {
      removeUserJob(userId);
      userStates.delete(userId);
      return await sendHtml(chatId,
        `✅ <b>Dibatalkan.</b>\n\n<blockquote>Ketik /start atau klik tombol di bawah untuk kembali ke menu utama.</blockquote>`,
        [[{ text: "🏠 Menu Utama", data: "start" }]], msgId
      );
    }
  } catch (err) {
    console.error("Callback error:", err);
  }
}

// ─── CREDIT PANEL ─────────────────────────────────────────────────────────
async function showCreditPanel(chatId, userId, editId = null) {
  if (!isPrivileged(userId)) return;
  const text =
    `<tg-emoji emoji-id="4965670789102699620">🌟</tg-emoji> <b>KELOLA CREDIT</b>\n────────────────────\n\n` +
    `<blockquote>Pilih aksi:</blockquote>\n\n` +
    `• ➕ <b>Tambah Credit</b>\n` +
    `• ➖ <b>Kurangi Credit</b>\n` +
    `• 🗑️ <b>Reset Credit</b>\n` +
    `• 📋 <b>Lihat Daftar Credit</b>`;
  const btns = [
    [{ text: "➕ Tambah", data: "credit_add_info" }, { text: "➖ Kurangi", data: "credit_reduce_info" }],
    [{ text: "🗑️ Reset", data: "credit_reset_info" }, { text: "📋 Daftar", data: "credit_list" }],
    [{ text: "◀ Admin Panel", data: "admin_panel" }],
  ];
  if (editId) {
    await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" });
  } else {
    await sendHtml(chatId, text, btns);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`<tg-emoji emoji-id="6041705726206808304">🚀</tg-emoji> Starting ${CONFIG.BOT_NAME}...`);
  console.log(`<tg-emoji emoji-id="6204104220694550861">☄️</tg-emoji> OWNER_ID: ${CONFIG.OWNER_ID}`);
  console.log(`<tg-emoji emoji-id="4965670789102699620">🌟</tg-emoji> CREDIT SYSTEM: Aktif — 1 build = 1 credit (exempt: Owner, Admin, Reseller)`);
  console.log(`🎯 PRIORITY: Owner (1) > Admin/Reseller (2) > User (3)`);
  console.log(`<tg-emoji emoji-id="6190336264940559752">💰</tg-emoji> QRIS PAYMENT: Aktif — User bisa beli credit via QRIS.`);

  if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });

  await client.start({ botAuthToken: CONFIG.BOT_TOKEN, onError: err => console.error("Client error:", err) });
  fs.writeFileSync(SESSION_FILE, client.session.save());
  console.log("✅ Bot connected & session saved!");

  client.addEventHandler(async (event) => {
    try {
      const msg    = event.message;
      const text   = msg?.text?.trim();
      const chatId = event.chatId;
      const userId = Number(msg.senderId);

      // ── Payment proof handling ──────────────────────────────────────
      const paymentProofHandled = await handlePaymentProof(event);
      if (paymentProofHandled) return;

      if (text === "/start")  return handleStart(event);
      if (text === "/help")   return handleHelp(chatId);

      // ── Broadcast ────────────────────────────────────────────────────
      if (text === "/broadcast" && isPrivileged(userId)) {
        const replied = await event.message.getReplyMessage();
        if (!replied) return sendHtml(chatId, `⚠️ <b>Cara Broadcast:</b>\n\n<blockquote>Reply pesan yang ingin di-broadcast, lalu ketik /broadcast</blockquote>`);
        isOwner(userId)
          ? await (async () => {
              const all = db.getAllUsers();
              const m   = await sendHtml(chatId, `📢 <b>Broadcast dimulai ke ${all.length} user...</b>`);
              let ok = 0, fail = 0;
              for (const u of all) {
                try {
                  replied.media
                    ? await client.sendFile(u.userId, { file: replied.media, caption: replied.text || "", parseMode: "md" })
                    : await client.sendMessage(u.userId, { message: replied.text || "", parseMode: "md" });
                  ok++;
                } catch (_) { fail++; }
                await sleep(100);
              }
              await editHtml(chatId, m.id, `<tg-emoji emoji-id="5123163417326126159">✅</tg-emoji> <b>Broadcast Selesai!</b>\n\n<blockquote><tg-emoji emoji-id="5780405967527089720">📢</tg-emoji> Total: ${all.length}\n<tg-emoji emoji-id="5123163417326126159">✅</tg-emoji> Sukses: ${ok}\n<tg-emoji emoji-id="6206110936789423908">❌</tg-emoji> Gagal: ${fail}</blockquote>`);
            })()
          : await handleBroadcastWithOwnerNotify(chatId, userId, replied);
        return;
      }

      if (text === "/weekly" || text === "/klaim") {
        return handleWeeklyClaim(chatId, userId);
      }
      if (text === "/mycredit") {
        const cr   = isCreditExempt(userId) ? "∞ (Unlimited)" : String(cdb.getCredit(userId));
        const role = getRoleName(userId);
        return sendHtml(chatId, `<tg-emoji emoji-id="4965670789102699620">🌟</tg-emoji> <b>Credit Kamu</b>\n────────────────────\n\n<blockquote><tg-emoji emoji-id="5837071798935492251">🆔</tg-emoji> ID: <code>${userId}</code>\n<tg-emoji emoji-id="5289722755871162900">🔥</tg-emoji> Role: <b>${role}</b>\n<tg-emoji emoji-id="4965670789102699620">🌟</tg-emoji> Credit: <b>${cr}</b></blockquote>`);
      }
      if (text?.startsWith("/addcredit") && isPrivileged(userId)) {
        return handleAddCredit(chatId, userId, text.replace("/addcredit", "").trim());
      }
      if (text?.startsWith("/reducecredit") && isPrivileged(userId)) {
        return handleReduceCredit(chatId, userId, text.replace("/reducecredit", "").trim());
      }
      if (text?.startsWith("/resetcredit") && isPrivileged(userId)) {
        return handleResetCredit(chatId, userId, text.replace("/resetcredit", "").trim());
      }
      if (text?.startsWith("/addpremium") && isOwner(userId)) {
        return handleAddPremium(chatId, userId, text.replace("/addpremium", "").trim());
      }
      if (text?.startsWith("/removepremium") && isOwner(userId)) {
        return handleRemovePremium(chatId, userId, text.replace("/removepremium", "").trim());
      }
      if (text === "/listpremium" && isOwner(userId)) {
        return handleListPremium(chatId, userId);
      }
      if (text?.startsWith("/addreseller") && isPrivileged(userId)) {
        const parts = text.split(" ");
        return handleAddReseller(chatId, userId, parts[1]);
      }
      if (text?.startsWith("/removereseller") && isPrivileged(userId)) {
        const parts = text.split(" ");
        return handleRemoveReseller(chatId, userId, parts[1]);
      }
      if ((text === "/listusers" || text?.match(/^\/listusers\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleListUsers(chatId, userId, page);
      }
      if ((text === "/listresellers" || text?.match(/^\/listresellers\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleListResellers(chatId, userId, page);
      }
      if (text?.startsWith("/searchuser") && isPrivileged(userId)) {
        return handleSearchUser(chatId, userId, text.replace("/searchuser", "").trim());
      }
      if (text?.startsWith("/userinfo") && isPrivileged(userId)) {
        return handleUserInfo(chatId, userId, text.replace("/userinfo", "").trim());
      }
      if (text?.startsWith("/deleteuser") && isPrivileged(userId)) {
        return handleDeleteUser(chatId, userId, text.replace("/deleteuser", "").trim());
      }
      if (text?.startsWith("/banuser") && isPrivileged(userId)) {
        return handleBanUser(chatId, userId, text.replace("/banuser", "").trim());
      }
      if (text?.startsWith("/unbanuser") && isPrivileged(userId)) {
        return handleUnbanUser(chatId, userId, text.replace("/unbanuser", "").trim());
      }
      if (text?.startsWith("/dmuser") && isPrivileged(userId)) {
        return handleDmUser(chatId, userId, text.replace("/dmuser", "").trim());
      }
      if (text === "/exportusers" && isPrivileged(userId)) {
        return handleExportUsers(chatId, userId);
      }
      if ((text === "/buildhistory" || text?.match(/^\/buildhistory\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleBuildHistory(chatId, userId, page);
      }
      if (text?.startsWith("/killbuild") && isPrivileged(userId)) {
        const targetId = parseInt(text.replace("/killbuild", "").trim());
        if (!isNaN(targetId)) {
          const job = getUserJob(targetId);
          if (!job) return sendHtml(chatId, `❌ <b>User ID <code>${targetId}</code> tidak sedang build.</b>`);
          removeUserJob(targetId);
          await sendHtml(chatId, `💀 <b>Build user <code>${targetId}</code> dihentikan paksa!</b>`);
          try { await client.sendMessage(job.chatId, { message: `⚠️ **Build kamu dihentikan paksa oleh admin.**`, parseMode: "md" }); } catch (_) {}
        }
        return;
      }

      // ── Payment admin commands ──────────────────────────────────────
      if (text?.startsWith("/approvepayment") && isPrivileged(userId)) {
        const paymentId = text.replace("/approvepayment", "").trim();
        if (!paymentId) return sendHtml(chatId, `❌ <b>Gunakan:</b> /approvepayment <id>`);
        await handleAdminPaymentApprove(chatId, userId, paymentId);
        return;
      }
      if (text?.startsWith("/rejectpayment") && isPrivileged(userId)) {
        const paymentId = text.replace("/rejectpayment", "").trim();
        if (!paymentId) return sendHtml(chatId, `❌ <b>Gunakan:</b> /rejectpayment <id>`);
        await handleAdminPaymentReject(chatId, userId, paymentId);
        return;
      }

      // ── Owner set payment info ─────────────────────────────────────
      if (text?.startsWith("/setpaymentinfo") && isOwner(userId)) {
        const info = text.replace("/setpaymentinfo", "").trim();
        if (!info) return sendHtml(chatId, `⚠️ <b>Gunakan:</b> /setpaymentinfo <instruksi>`);
        const config = getPaymentConfig();
        config.instructions = info;
        savePaymentConfig(config);
        return sendHtml(chatId, `✅ <b>Instruksi pembayaran diperbarui!</b>\n\n<blockquote>${info}</blockquote>`);
      }
      if (text === "/setqris" && isOwner(userId)) {
        userStates.set(userId, { step: "WAITING_QRIS" });
        return sendHtml(chatId,
          `📸 <b>Set QRIS</b>\n────────────────────\n\n<blockquote>Kirim <b>foto QRIS</b> (format gambar).\n\nFoto ini akan ditampilkan saat user membeli credit.</blockquote>`,
          [[{ text: "❌ Batal", data: "cancel" }]]
        );
      }

      // ── Cek user / dc ──────────────────────────────────────────────
      if (text?.startsWith("/cekuser") || text?.startsWith("/cekid")) {
        const q = text.split(" ").slice(1).join(" ").trim();
        return handleCekUser(chatId, userId, q || null);
      }
      if (text === "/cekdc") {
        return handleCekDC(chatId, userId);
      }

      const reported = await handleUserReportMessages(event);
      if (reported) return;

      const job = getUserJob(userId);
      if (job?.type === "web2apk") {
        if (job.status === "waiting_url"     && text?.startsWith("http")) return handleWeb2ApkUrl(event);
        if (job.status === "waiting_appname" && text)                     return handleWeb2ApkName(event);
        if (job.status === "waiting_icon"    && msg.media)                return handleWeb2ApkIcon(event);
      }

      if (msg.media) await handleZipFile(event);
    } catch (err) { console.error("Handler error:", err); }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    try { await handleCallback(event); }
    catch (err) { console.error("Callback error:", err); }
  }, new CallbackQuery({}));

  console.log(`🤖 ${CONFIG.BOT_NAME} v${CONFIG.BOT_VERSION} aktif!`);

  // ── WEEKLY AUTO CREDIT SCHEDULER ────────────────────────────────────
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setTimeout(() => runWeeklyAutoCredit().catch(console.error), 10000);
  setInterval(() => runWeeklyAutoCredit().catch(console.error), SIX_HOURS);
  console.log(`<tg-emoji emoji-id="4974414728337032308">🎁</tg-emoji> Weekly Auto Credit Scheduler aktif — cek setiap 6 jam.`);

  await new Promise(() => {});
}

main();