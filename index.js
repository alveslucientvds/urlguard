"use strict";

require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
  ActivityType,
  Events
} = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");

/* =========================
   BASIC RUNTIME HARDENING
========================= */
Error.stackTraceLimit = 50;
process.setMaxListeners(100);

/* =========================
   ENV
========================= */
const TOKEN = String(process.env.TOKEN || "").trim();
const GUILD_ID = String(process.env.GUILD_ID || "").trim();
const LOG_CHANNEL_ID = String(process.env.LOG_CHANNEL_ID || "").trim() || null;
const PROTECTED_VANITY_RAW = String(process.env.PROTECTED_VANITY || "").trim() || null;
const VOICE_CHANNEL_ID = String(process.env.VOICE_CHANNEL_ID || "").trim() || null;
const PORT = Number(process.env.PORT) || 3000;

function fatal(msg) {
  console.error(`[FATAL] ${msg}`);
  process.exit(1);
}

if (!TOKEN) fatal("TOKEN eksik.");
if (!GUILD_ID) fatal("GUILD_ID eksik.");

const VANITY_CODE_REGEX = /^[a-zA-Z0-9-]{2,32}$/;

function normalizeVanityCode(input) {
  if (!input) return null;

  let value = String(input).trim();

  value = value
    .replace(/^https?:\/\/(www\.)?discord\.(gg|com\/invite)\//i, "")
    .replace(/^discord\.(gg|com\/invite)\//i, "")
    .replace(/^\/+/, "")
    .trim();

  if (!VANITY_CODE_REGEX.test(value)) {
    console.warn(`[ENV] PROTECTED_VANITY geçersiz görünüyor: ${input}`);
    return null;
  }

  return value;
}

const PROTECTED_VANITY = normalizeVanityCode(PROTECTED_VANITY_RAW);

/* =========================
   CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ],
  allowedMentions: {
    parse: [],
    repliedUser: false
  }
});

/* =========================
   WEB SERVER / UPTIMEROBOT
========================= */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

let lastHeartbeatAt = Date.now();

app.get("/", (_, res) => {
  lastHeartbeatAt = Date.now();
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send("URL Guard bot aktif.");
});

app.get("/health", (_, res) => {
  lastHeartbeatAt = Date.now();
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    ready: client.isReady(),
    bot: client?.user?.tag || "loading",
    wsPing: client.ws?.ping ?? null,
    uptimeSeconds: Math.floor(process.uptime()),
    memory: {
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
      heapTotal: process.memoryUsage().heapTotal
    },
    guildId: GUILD_ID,
    voiceConfigured: Boolean(VOICE_CHANNEL_ID),
    protectedVanity: PROTECTED_VANITY,
    lastHeartbeatAt,
    timestamp: new Date().toISOString()
  });
});

app.get("/ping", (_, res) => {
  lastHeartbeatAt = Date.now();
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    status: "online",
    ready: client.isReady(),
    wsPing: client.ws?.ping ?? null,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

app.use((_, res) => {
  lastHeartbeatAt = Date.now();
  return res.status(200).send("Bot aktif.");
});

const webServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[WEB] Sunucu ${PORT} portunda aktif.`);
});

webServer.keepAliveTimeout = 65_000;
webServer.headersTimeout = 66_000;
webServer.requestTimeout = 60_000;

webServer.on("error", (err) => {
  console.error("[WEB] Sunucu hatası:", err);
});

webServer.on("clientError", (err, socket) => {
  console.error("[WEB] Client hatası:", err?.message || err);
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {}
});

/* =========================
   CACHE / STATE
========================= */
const vanityCache = new Map();             // guildId -> protected vanity
const revertLocks = new Map();             // guildId -> unlock timestamp
const recentActions = new Map();           // key -> timestamp
const recentLogKeys = new Map();           // anti log spam
const voiceReconnectState = new Map();     // guildId -> reconnect attempt count
const voiceJoinLocks = new Map();          // guildId -> boolean
const voiceReconnectTimers = new Map();    // guildId -> Timeout
const guildBootstrapLocks = new Map();     // guildId -> boolean

let startupFinished = false;
let bootstrapRunning = false;
let keepAliveRunning = false;
let shuttingDown = false;

/* =========================
   HELPERS
========================= */
function nowTr() {
  return new Date().toLocaleString("tr-TR", {
    dateStyle: "short",
    timeStyle: "medium"
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanString(value, max = 1000) {
  if (value == null) return "Yok";

  const str = String(value)
    .replace(/[`]/g, "'")
    .replace(/<@&?\d+>/g, "[mention-redacted]")
    .replace(/<@!?\d+>/g, "[mention-redacted]")
    .replace(/@everyone/g, "@ everyone")
    .replace(/@here/g, "@ here")
    .trim();

  return str.length > max ? `${str.slice(0, max - 3)}...` : (str || "Yok");
}

function safeTimeout(fn, ms) {
  const t = setTimeout(fn, ms);
  if (typeof t.unref === "function") t.unref();
  return t;
}

function safeInterval(fn, ms) {
  const t = setInterval(fn, ms);
  if (typeof t.unref === "function") t.unref();
  return t;
}

function isLockActive(guildId) {
  const until = revertLocks.get(guildId) || 0;
  if (Date.now() >= until) {
    revertLocks.delete(guildId);
    return false;
  }
  return true;
}

function setLock(guildId, ms) {
  revertLocks.set(guildId, Date.now() + ms);
}

function dedupeEvent(key, windowMs) {
  const last = recentActions.get(key) || 0;
  if (Date.now() - last < windowMs) return true;
  recentActions.set(key, Date.now());
  return false;
}

function dedupeLog(key, windowMs) {
  const last = recentLogKeys.get(key) || 0;
  if (Date.now() - last < windowMs) return true;
  recentLogKeys.set(key, Date.now());
  return false;
}

function cleanupMaps() {
  const now = Date.now();

  for (const [k, v] of recentActions.entries()) {
    if (now - v > 5 * 60_000) recentActions.delete(k);
  }

  for (const [k, v] of recentLogKeys.entries()) {
    if (now - v > 5 * 60_000) recentLogKeys.delete(k);
  }

  for (const [k, v] of revertLocks.entries()) {
    if (now >= v) revertLocks.delete(k);
  }

  for (const [k, v] of voiceReconnectState.entries()) {
    if (typeof v !== "number" || v < 0) voiceReconnectState.delete(k);
  }
}

function getLogChannel(guild) {
  if (!LOG_CHANNEL_ID) return null;
  const channel = guild.channels.cache.get(LOG_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

async function sendLog(guild, embed, dedupeKey = null) {
  try {
    if (!guild) return;
    if (dedupeKey && dedupeLog(dedupeKey, 4000)) return;

    const logChannel = getLogChannel(guild);
    if (!logChannel) return;

    await logChannel.send({
      embeds: [embed],
      allowedMentions: { parse: [] }
    }).catch((err) => {
      console.error("[LOG] Log gönderilemedi:", err);
    });
  } catch (err) {
    console.error("[LOG] sendLog genel hata:", err);
  }
}

function getBotMember(guild) {
  return guild?.members?.me ?? null;
}

function botCanBan(me, targetMember) {
  if (!me || !targetMember) return false;
  if (!me.permissions.has(PermissionsBitField.Flags.BanMembers)) return false;
  if (targetMember.id === targetMember.guild.ownerId) return false;
  if (targetMember.id === me.id) return false;
  return me.roles.highest.position > targetMember.roles.highest.position;
}

function botCanManageGuild(me) {
  if (!me) return false;
  return me.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

function botCanViewAudit(me) {
  if (!me) return false;
  return me.permissions.has(PermissionsBitField.Flags.ViewAuditLog);
}

function clearVoiceReconnectTimer(guildId) {
  const t = voiceReconnectTimers.get(guildId);
  if (t) {
    clearTimeout(t);
    voiceReconnectTimers.delete(guildId);
  }
}

function scheduleVoiceReconnect(guild, immediate = false) {
  if (!guild || !VOICE_CHANNEL_ID || shuttingDown) return;

  const guildId = guild.id;
  clearVoiceReconnectTimer(guildId);

  const attempts = (voiceReconnectState.get(guildId) || 0) + 1;
  voiceReconnectState.set(guildId, attempts);

  const delay = immediate ? 1500 : Math.min(5000 * attempts, 30000);

  console.log(`[VOICE] ${delay}ms sonra yeniden bağlanma denenecek. Attempt=${attempts}`);

  const timer = safeTimeout(async () => {
    voiceReconnectTimers.delete(guildId);
    await joinConfiguredVoice(guild, true);
  }, delay);

  voiceReconnectTimers.set(guildId, timer);
}

async function fetchExecutorFromAudit(guild, expectedNewCode = null) {
  const me = getBotMember(guild);
  if (!botCanViewAudit(me)) {
    console.warn("[AUDIT] Botta ViewAuditLog izni yok.");
    return null;
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await sleep(1000 * attempt);

      const logs = await guild.fetchAuditLogs({
        type: AuditLogEvent.GuildUpdate,
        limit: 10
      });

      const entry = logs.entries.find((e) => {
        if (!e || !e.executor) return false;
        if (e.targetId !== guild.id) return false;

        const created = e.createdTimestamp || 0;
        if (Date.now() - created > 25_000) return false;

        const changes = Array.isArray(e.changes) ? e.changes : [];
        const vanityChange = changes.find((c) => c.key === "vanity_url_code");
        if (!vanityChange) return false;

        if (expectedNewCode !== null) {
          const newValue = vanityChange.new ?? null;
          if ((newValue || null) !== (expectedNewCode || null)) return false;
        }

        return true;
      });

      if (entry) return entry;
    } catch (err) {
      console.error(`[AUDIT] Audit log çekilemedi (deneme ${attempt}):`, err);
    }
  }

  return null;
}

async function banExecutor(guild, executor, reason) {
  try {
    if (!executor) {
      return { ok: false, reason: "İşlemi yapan kullanıcı bulunamadı." };
    }

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const targetMember = await guild.members.fetch(executor.id).catch(() => null);

    if (!targetMember) {
      return { ok: false, reason: "Kullanıcı sunucuda bulunamadı." };
    }

    if (!botCanBan(me, targetMember)) {
      return {
        ok: false,
        reason: "Botun yetkisi/rol sırası yetersiz veya hedef sunucu sahibi."
      };
    }

    await guild.members.ban(executor.id, {
      reason: cleanString(reason, 480),
      deleteMessageSeconds: 0
    });

    return { ok: true };
  } catch (err) {
    console.error("[BAN] Ban atılamadı:", err);
    return {
      ok: false,
      reason: cleanString(err?.message || "Bilinmeyen hata", 300)
    };
  }
}

async function revertVanity(guild, protectedCode) {
  try {
    if (!protectedCode) {
      return { ok: false, reason: "Korunan vanity kodu bulunamadı." };
    }

    const me = getBotMember(guild) || await guild.members.fetchMe().catch(() => null);
    if (!botCanManageGuild(me)) {
      return { ok: false, reason: "Botta ManageGuild izni yok." };
    }

    await guild.edit(
      { vanityURLCode: protectedCode },
      "URL Guard: Vanity URL eski haline döndürüldü."
    );

    return { ok: true };
  } catch (err) {
    console.error("[REVERT] Vanity geri alınamadı:", err);
    return {
      ok: false,
      reason: cleanString(err?.message || "Bilinmeyen hata", 300)
    };
  }
}

async function initializeProtectedVanity(guild) {
  try {
    const freshGuild = await guild.fetch();
    const currentCode = freshGuild.vanityURLCode || null;
    const protectedCode = PROTECTED_VANITY || currentCode || null;

    vanityCache.set(guild.id, protectedCode);

    console.log(`[INIT] Korunan vanity: ${protectedCode || "YOK"}`);

    const embed = new EmbedBuilder()
      .setAuthor({
        name: "URL GUARD",
        iconURL: client.user.displayAvatarURL()
      })
      .setTitle("Koruma Sistemi Aktif")
      .setDescription(
        [
          `**Sunucu:** ${cleanString(guild.name, 100)}`,
          `**Korunan URL:** ${protectedCode ? `discord.gg/${protectedCode}` : "Yok"}`,
          `**Saat:** ${nowTr()}`
        ].join("\n")
      )
      .setColor(0x57f287)
      .setFooter({ text: "Sistem başarıyla başlatıldı." })
      .setTimestamp();

    await sendLog(guild, embed, `init:${guild.id}`);

    if (PROTECTED_VANITY && currentCode && currentCode !== PROTECTED_VANITY) {
      console.warn(
        `[INIT] Mevcut vanity (${currentCode}) ile PROTECTED_VANITY (${PROTECTED_VANITY}) farklı.`
      );
    }
  } catch (err) {
    console.error("[INIT] Protected vanity başlatılamadı:", err);
  }
}

async function setBotPresence() {
  try {
    if (!client.user) return;

    await client.user.setPresence({
      status: "dnd",
      activities: [
        {
          name: "URL'yi koruyor",
          type: ActivityType.Watching
        }
      ]
    });
  } catch (err) {
    console.error("[PRESENCE] Durum ayarlanamadı:", err);
  }
}

async function joinConfiguredVoice(guild, force = false) {
  if (!guild || !VOICE_CHANNEL_ID || shuttingDown) return;

  const guildId = guild.id;
  if (voiceJoinLocks.get(guildId) && !force) return;

  voiceJoinLocks.set(guildId, true);

  try {
    const channel = await guild.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.log("[VOICE] Ses kanalı bulunamadı.");
      return;
    }

    if (
      channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildStageVoice
    ) {
      console.log("[VOICE] Belirtilen kanal ses/stage kanalı değil.");
      return;
    }

    const me = getBotMember(guild) || await guild.members.fetchMe().catch(() => null);
    const permissions = channel.permissionsFor(me);

    if (!permissions || !permissions.has(PermissionsBitField.Flags.Connect)) {
      console.log("[VOICE] Botun ses kanalına bağlanma izni yok.");
      return;
    }

    const existing = getVoiceConnection(guildId);
    if (existing) {
      const sameChannel = existing.joinConfig?.channelId === channel.id;
      const status = existing.state?.status;
      const healthy = [
        VoiceConnectionStatus.Ready,
        VoiceConnectionStatus.Connecting,
        VoiceConnectionStatus.Signalling
      ].includes(status);

      if (sameChannel && healthy && !force) {
        return;
      }

      try {
        existing.removeAllListeners();
      } catch {}

      try {
        existing.destroy();
      } catch (err) {
        console.error("[VOICE] Eski bağlantı kapatılamadı:", err);
      }
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
      group: guild.id
    });

    connection.on("error", (err) => {
      console.error("[VOICE] Connection error:", err);
      try {
        connection.destroy();
      } catch {}
      scheduleVoiceReconnect(guild);
    });

    connection.on("stateChange", async (oldState, newState) => {
      try {
        const oldStatus = oldState?.status;
        const newStatus = newState?.status;

        if (oldStatus === newStatus) return;

        if (newStatus === VoiceConnectionStatus.Ready) {
          voiceReconnectState.set(guildId, 0);
          clearVoiceReconnectTimer(guildId);
          console.log(`[VOICE] Ses bağlantısı hazır: ${channel.name}`);
          return;
        }

        if (newStatus === VoiceConnectionStatus.Disconnected) {
          try {
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
            ]);
            console.log("[VOICE] Geçici disconnect toparlandı.");
            return;
          } catch {
            console.warn("[VOICE] Disconnect toparlanamadı, yeniden bağlanılacak.");
            try {
              connection.destroy();
            } catch {}
            scheduleVoiceReconnect(guild);
            return;
          }
        }

        if (newStatus === VoiceConnectionStatus.Destroyed) {
          console.warn("[VOICE] Bağlantı destroyed oldu.");
          scheduleVoiceReconnect(guild);
        }
      } catch (err) {
        console.error("[VOICE] stateChange hatası:", err);
        scheduleVoiceReconnect(guild);
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    voiceReconnectState.set(guildId, 0);
    clearVoiceReconnectTimer(guildId);
    console.log(`[VOICE] Otomatik olarak "${channel.name}" kanalına katıldı.`);
  } catch (err) {
    console.error("[VOICE] Ses kanalına giriş hatası:", err);
    scheduleVoiceReconnect(guild);
  } finally {
    voiceJoinLocks.delete(guildId);
  }
}

async function bootstrap() {
  if (bootstrapRunning || shuttingDown) return;
  bootstrapRunning = true;

  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) {
      console.error("[BOOT] GUILD_ID ile sunucu bulunamadı.");
      return;
    }

    const fullGuild = await guild.fetch().catch(() => null);
    if (!fullGuild) {
      console.error("[BOOT] Sunucu fetch edilemedi.");
      return;
    }

    await setBotPresence();

    if (!startupFinished) {
      await initializeProtectedVanity(fullGuild);
      startupFinished = true;
    }

    await joinConfiguredVoice(fullGuild);
  } catch (err) {
    console.error("[BOOT] Bootstrap hatası:", err);
  } finally {
    bootstrapRunning = false;
  }
}

async function bootstrapGuild(guild) {
  if (!guild || guild.id !== GUILD_ID || shuttingDown) return;
  if (guildBootstrapLocks.get(guild.id)) return;

  guildBootstrapLocks.set(guild.id, true);
  try {
    await setBotPresence();

    if (!startupFinished) {
      await initializeProtectedVanity(guild);
      startupFinished = true;
    }

    await joinConfiguredVoice(guild);
  } catch (err) {
    console.error("[BOOT-GUILD] Hata:", err);
  } finally {
    guildBootstrapLocks.delete(guild.id);
  }
}

async function verifyVanityIntegrity(guild) {
  try {
    const protectedCode = vanityCache.get(guild.id) || PROTECTED_VANITY || null;
    if (!protectedCode) return;

    const freshGuild = await guild.fetch().catch(() => null);
    if (!freshGuild) return;

    const liveCode = freshGuild.vanityURLCode || null;
    if (liveCode === protectedCode) return;
    if (isLockActive(guild.id)) return;

    setLock(guild.id, 10_000);

    const auditEntry = await fetchExecutorFromAudit(freshGuild, liveCode);
    const executor = auditEntry?.executor || null;

    const revertResult = await revertVanity(freshGuild, protectedCode);

    let banResult = { ok: false, reason: "Yapan kişi bulunamadı." };
    if (executor && executor.id !== client.user.id) {
      banResult = await banExecutor(
        freshGuild,
        executor,
        `URL Guard self-heal: Vanity URL yetkisiz değişiklik. Korunan URL: ${protectedCode}`
      );
    } else if (executor && executor.id === client.user.id) {
      banResult = { ok: false, reason: "İşlem bot tarafından yapıldı, ban atılmadı." };
    }

    if (revertResult.ok) {
      vanityCache.set(guild.id, protectedCode);
    }

    const embed = new EmbedBuilder()
      .setAuthor({
        name: "URL GUARD",
        iconURL: client.user.displayAvatarURL()
      })
      .setTitle("Self-Heal Vanity Müdahalesi")
      .setDescription(
        [
          "Periyodik kontrolde korunan vanity URL ile canlı değer farklı bulundu.",
          `**Korunan URL:** ${protectedCode ? `discord.gg/${protectedCode}` : "Yok"}`,
          `**Canlı Değer:** ${liveCode ? `discord.gg/${liveCode}` : "Silinmiş / Boş"}`
        ].join("\n")
      )
      .addFields(
        {
          name: "İşlemi Yapan",
          value: executor
            ? `<@${executor.id}>\n\`${cleanString(executor.tag, 80)}\`\n\`${executor.id}\``
            : "Bulunamadı",
          inline: true
        },
        {
          name: "Ban Durumu",
          value: banResult.ok ? "✅ Başarılı" : `❌ ${cleanString(banResult.reason, 120)}`,
          inline: true
        },
        {
          name: "URL Geri Yüklendi",
          value: revertResult.ok ? "✅ Evet" : `❌ ${cleanString(revertResult.reason, 120)}`,
          inline: true
        }
      )
      .setColor(0xfaa61a)
      .setTimestamp();

    await sendLog(freshGuild, embed, `selfheal:${guild.id}:${liveCode || "none"}`);
  } catch (err) {
    console.error("[SELF-HEAL] Vanity integrity hatası:", err);
  }
}

async function shutdown(code = 0, signal = "UNKNOWN") {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[PROCESS] Shutdown başladı. signal=${signal} code=${code}`);

  try {
    clearVoiceReconnectTimer(GUILD_ID);
  } catch {}

  try {
    const conn = getVoiceConnection(GUILD_ID);
    if (conn) conn.destroy();
  } catch (err) {
    console.error("[PROCESS] Voice destroy hatası:", err);
  }

  try {
    await client.destroy();
  } catch (err) {
    console.error("[PROCESS] Client destroy hatası:", err);
  }

  try {
    await new Promise((resolve) => {
      webServer.close(() => resolve());
    });
  } catch (err) {
    console.error("[PROCESS] Web close hatası:", err);
  }

  process.exit(code);
}

/* =========================
   READY / RESUME
========================= */
client.once(Events.ClientReady, async () => {
  console.log(`[BOT] ${client.user.tag} olarak giriş yapıldı.`);
  await bootstrap();
});

client.on("resume", async () => {
  console.log("[CLIENT] Resume oldu.");
  await bootstrap();
});

client.on("guildAvailable", async (guild) => {
  if (guild.id !== GUILD_ID) return;
  console.log("[GUILD] guildAvailable");
  await bootstrapGuild(guild);
});

client.on("guildUnavailable", (guild) => {
  if (guild.id !== GUILD_ID) return;
  console.warn("[GUILD] guildUnavailable");
});

client.on("shardDisconnect", (event, id) => {
  console.error(`[SHARD] Disconnect | shard=${id} code=${event?.code || "unknown"}`);
});

client.on("shardReconnecting", (id) => {
  console.log(`[SHARD] Reconnecting | shard=${id}`);
});

client.on("shardReady", async (id) => {
  console.log(`[SHARD] Ready | shard=${id}`);
  await bootstrap();
});

client.on("shardResume", async (id, replayed) => {
  console.log(`[SHARD] Resume | shard=${id} replayed=${replayed}`);
  await bootstrap();
});

client.on("shardError", (err, id) => {
  console.error(`[SHARD] Error | shard=${id}`, err);
});

client.on("error", (err) => {
  console.error("[CLIENT ERROR]", err);
});

client.on("warn", (info) => {
  console.warn("[CLIENT WARN]", info);
});

client.on("invalidated", async () => {
  console.error("[CLIENT] Session invalidated.");
  await shutdown(1, "INVALIDATED");
});

client.ws.on("debug", () => {});

/* =========================
   URL GUARD
========================= */
client.on("guildUpdate", async (oldGuild, newGuild) => {
  try {
    if (newGuild.id !== GUILD_ID) return;

    const oldCode = oldGuild.vanityURLCode || vanityCache.get(newGuild.id) || null;
    const newCode = newGuild.vanityURLCode || null;

    if (oldCode === newCode) return;
    if (isLockActive(newGuild.id)) return;

    setLock(newGuild.id, 12_000);

    const protectedCode =
      vanityCache.get(newGuild.id) ||
      PROTECTED_VANITY ||
      oldCode ||
      null;

    if (!protectedCode) {
      console.warn("[URL GUARD] Korunan vanity bulunamadı, revert yapılamadı.");
      return;
    }

    const eventKey = `guildUpdate:${newGuild.id}:${newCode || "null"}`;
    if (dedupeEvent(eventKey, 5000)) return;

    const auditEntry = await fetchExecutorFromAudit(newGuild, newCode);
    const executor = auditEntry?.executor || null;

    let banResult = { ok: false, reason: "Yapan kişi audit log üzerinden bulunamadı." };

    if (executor && executor.id !== client.user.id) {
      const banReason =
        `URL Guard: Sunucunun vanity URL'sini değiştirmeye veya silmeye çalıştı. Korunan URL: ${protectedCode}`;
      banResult = await banExecutor(newGuild, executor, banReason);
    } else if (executor && executor.id === client.user.id) {
      banResult = { ok: false, reason: "İşlem bot tarafından yapıldı, ban atılmadı." };
    }

    const revertResult = await revertVanity(newGuild, protectedCode);

    if (revertResult.ok && protectedCode) {
      vanityCache.set(newGuild.id, protectedCode);
    }

    const embed = new EmbedBuilder()
      .setAuthor({
        name: "URL GUARD",
        iconURL: client.user.displayAvatarURL()
      })
      .setTitle("Vanity URL Koruması Tetiklendi")
      .setDescription(
        [
          "Sunucunun özel davet bağlantısını değiştirme veya silme girişimi algılandı.",
          "",
          `**Korunan URL:** ${protectedCode ? `discord.gg/${protectedCode}` : "Yok"}`,
          `**Eski Değer:** ${oldCode ? `discord.gg/${oldCode}` : "Yok"}`,
          `**Yeni Değer:** ${newCode ? `discord.gg/${newCode}` : "Silinmiş / Boş"}`
        ].join("\n")
      )
      .addFields(
        {
          name: "İşlemi Yapan",
          value: executor
            ? `<@${executor.id}>\n\`${cleanString(executor.tag, 80)}\`\n\`${executor.id}\``
            : "Bulunamadı",
          inline: true
        },
        {
          name: "Ban Durumu",
          value: banResult.ok
            ? "✅ Başarılı"
            : `❌ ${cleanString(banResult.reason, 180)}`,
          inline: true
        },
        {
          name: "URL Geri Yüklendi",
          value: revertResult.ok
            ? "✅ Evet"
            : `❌ ${cleanString(revertResult.reason, 180)}`,
          inline: true
        }
      )
      .setColor(0xed4245)
      .setThumbnail(
        executor
          ? executor.displayAvatarURL({ size: 256, extension: "png" })
          : client.user.displayAvatarURL({ size: 256, extension: "png" })
      )
      .setFooter({
        text: `${cleanString(newGuild.name, 60)} • ${nowTr()}`
      })
      .setTimestamp();

    await sendLog(
      newGuild,
      embed,
      `guard:${newGuild.id}:${oldCode || "old-none"}:${newCode || "new-none"}`
    );

    console.log(
      `[URL GUARD] Değişiklik algılandı | eski=${oldCode} yeni=${newCode} korunan=${protectedCode} yapan=${executor?.tag || "bulunamadı"}`
    );
  } catch (err) {
    console.error("[guildUpdate] Hata:", err);
  }
});

/* =========================
   PERIODIC SELF-HEAL
========================= */
safeInterval(async () => {
  if (keepAliveRunning || shuttingDown) return;
  keepAliveRunning = true;

  try {
    cleanupMaps();

    if (!client.isReady()) return;

    await setBotPresence();

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;

    await verifyVanityIntegrity(guild);

    if (VOICE_CHANNEL_ID) {
      const connection = getVoiceConnection(guild.id);
      const status = connection?.state?.status || null;
      const broken =
        !connection ||
        status === VoiceConnectionStatus.Destroyed ||
        status === VoiceConnectionStatus.Disconnected;

      if (broken) {
        console.log("[SELF-HEAL] Ses bağlantısı eksik/kırık, yeniden bağlanılıyor.");
        await joinConfiguredVoice(guild, true);
      }
    }
  } catch (err) {
    console.error("[SELF-HEAL] Hata:", err);
  } finally {
    keepAliveRunning = false;
  }
}, 60_000);

/* =========================
   LIGHT MEMORY WATCHER
========================= */
safeInterval(() => {
  try {
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    const heapMb = Math.round(mem.heapUsed / 1024 / 1024);

    if (rssMb >= 450) {
      console.warn(`[MEMORY] Yüksek kullanım algılandı | rss=${rssMb}MB heap=${heapMb}MB`);
    }
  } catch (err) {
    console.error("[MEMORY] Kontrol hatası:", err);
  }
}, 120_000);

/* =========================
   PROCESS SAFETY
========================= */
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("rejectionHandled", () => {
  console.warn("[rejectionHandled] Sonradan handle edilen promise rejection algılandı.");
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

process.on("uncaughtExceptionMonitor", (err) => {
  console.error("[uncaughtExceptionMonitor]", err);
});

process.on("SIGTERM", async () => {
  await shutdown(0, "SIGTERM");
});

process.on("SIGINT", async () => {
  await shutdown(0, "SIGINT");
});

/* =========================
   LOGIN
========================= */
client.login(TOKEN).catch(async (err) => {
  console.error("[LOGIN] Bot giriş yapamadı:", err);
  await shutdown(1, "LOGIN_FAIL");
});
