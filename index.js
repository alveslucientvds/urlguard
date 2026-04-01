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
   ENV
========================= */
const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;
const PROTECTED_VANITY = process.env.PROTECTED_VANITY || null;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || null;
const PORT = Number(process.env.PORT) || 3000;

if (!TOKEN) console.error("[ENV] TOKEN eksik.");
if (!GUILD_ID) console.error("[ENV] GUILD_ID eksik.");

/* =========================
   WEB SERVER / UPTIMEROBOT
========================= */
const app = express();

app.get("/", (_, res) => {
  res.status(200).send("URL Guard bot aktif.");
});

app.get("/health", (_, res) => {
  res.status(200).json({
    ok: true,
    bot: client?.user?.tag || "loading",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get("/ping", (_, res) => {
  res.status(200).json({
    status: "online",
    bot: client?.user?.tag || "loading",
    uptime: process.uptime(),
    memory: process.memoryUsage().rss
  });
});

app.use((_, res) => {
  res.status(200).send("Bot aktif.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[WEB] Sunucu ${PORT} portunda aktif.`);
});

/* =========================
   CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

/* =========================
   CACHE / STATE
========================= */
const vanityCache = new Map();
const revertLocks = new Set();
const recentActions = new Map();

let startupFinished = false;
let voiceJoinInProgress = false;

/* =========================
   HELPERS
========================= */
function nowTr() {
  return new Date().toLocaleString("tr-TR");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLogChannel(guild) {
  if (!LOG_CHANNEL_ID) return null;
  return guild.channels.cache.get(LOG_CHANNEL_ID) || null;
}

async function sendLog(guild, embed) {
  try {
    const logChannel = getLogChannel(guild);
    if (!logChannel || !logChannel.isTextBased()) return;
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error("[LOG] Log gönderilemedi:", err);
  }
}

function botCanBan(me, targetMember) {
  if (!me || !targetMember) return false;
  if (!me.permissions.has(PermissionsBitField.Flags.BanMembers)) return false;
  if (targetMember.id === targetMember.guild.ownerId) return false;
  return me.roles.highest.position > targetMember.roles.highest.position;
}

async function fetchExecutorFromAudit(guild) {
  try {
    await sleep(1500);

    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.GuildUpdate,
      limit: 10
    });

    const entry = logs.entries.find((e) => {
      if (!e || !e.executor) return false;
      if (e.targetId !== guild.id) return false;

      const created = e.createdTimestamp || 0;
      return Date.now() - created < 20000;
    });

    return entry || null;
  } catch (err) {
    console.error("[AUDIT] Audit log çekilemedi:", err);
    return null;
  }
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
        reason: "Botun rolü yetmiyor veya hedef sunucu sahibi."
      };
    }

    await guild.members.ban(executor.id, { reason });
    return { ok: true };
  } catch (err) {
    console.error("[BAN] Ban atılamadı:", err);
    return { ok: false, reason: err.message || "Bilinmeyen hata" };
  }
}

async function revertVanity(guild, protectedCode) {
  try {
    if (!protectedCode) {
      return { ok: false, reason: "Korunan URL kodu bulunamadı." };
    }

    await guild.edit(
      { vanityURLCode: protectedCode },
      "URL Guard: Vanity URL eski haline döndürüldü."
    );

    return { ok: true };
  } catch (err) {
    console.error("[REVERT] Vanity geri alınamadı:", err);
    return { ok: false, reason: err.message || "Bilinmeyen hata" };
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
          `**Sunucu:** ${guild.name}`,
          `**Korunan URL:** ${protectedCode ? `discord.gg/${protectedCode}` : "Yok"}`,
          `**Saat:** ${nowTr()}`
        ].join("\n")
      )
      .setColor(0x57f287)
      .setFooter({ text: "Sistem başarıyla başlatıldı." })
      .setTimestamp();

    await sendLog(guild, embed);
  } catch (err) {
    console.error("[INIT] Protected vanity başlatılamadı:", err);
  }
}

async function setBotPresence() {
  try {
    if (!client.user) return;

    await client.user.setPresence({
      status: "online",
      activities: [
        {
          name: "URL'yi izliyor",
          type: ActivityType.Streaming,
          url: "https://www.twitch.tv/discord"
        }
      ]
    });

    console.log("[PRESENCE] Bot online + streaming olarak ayarlandı.");
  } catch (err) {
    console.error("[PRESENCE] Durum ayarlanamadı:", err);
  }
}

async function joinConfiguredVoice(guild) {
  try {
    if (voiceJoinInProgress) return;
    voiceJoinInProgress = true;

    if (!VOICE_CHANNEL_ID) {
      console.log("[VOICE] VOICE_CHANNEL_ID tanımlı değil.");
      return;
    }

    const channel = await guild.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.log("[VOICE] Ses kanalı bulunamadı.");
      return;
    }

    if (
      channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildStageVoice
    ) {
      console.log("[VOICE] Belirtilen kanal bir ses kanalı değil.");
      return;
    }

    const permissions = channel.permissionsFor(guild.members.me);
    if (
      !permissions ||
      !permissions.has(PermissionsBitField.Flags.Connect)
    ) {
      console.log("[VOICE] Botun ses kanalına bağlanma izni yok.");
      return;
    }

    const existing = getVoiceConnection(guild.id);
    if (existing) {
      const sameChannel = existing.joinConfig?.channelId === channel.id;
      const healthy =
        existing.state.status === VoiceConnectionStatus.Ready ||
        existing.state.status === VoiceConnectionStatus.Connecting ||
        existing.state.status === VoiceConnectionStatus.Signalling;

      if (sameChannel && healthy) {
        return;
      }

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
      selfMute: false
    });

    connection.on("stateChange", async (_, newState) => {
      try {
        console.log(`[VOICE] Durum değişti: ${newState.status}`);

        if (newState.status === VoiceConnectionStatus.Disconnected) {
          console.log("[VOICE] Ses bağlantısı koptu, yeniden bağlanılacak.");
          await sleep(5000);
          await joinConfiguredVoice(guild);
        }

        if (newState.status === VoiceConnectionStatus.Destroyed) {
          console.log("[VOICE] Ses bağlantısı destroy oldu, yeniden bağlanılacak.");
          await sleep(5000);
          await joinConfiguredVoice(guild);
        }
      } catch (err) {
        console.error("[VOICE] stateChange hatası:", err);
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    console.log(`[VOICE] Otomatik olarak "${channel.name}" kanalına katıldı.`);
  } catch (err) {
    console.error("[VOICE] Ses kanalına giriş hatası:", err);
  } finally {
    voiceJoinInProgress = false;
  }
}

async function bootstrap() {
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
  }
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

client.on("error", (err) => {
  console.error("[CLIENT ERROR]", err);
});

client.on("warn", (info) => {
  console.warn("[CLIENT WARN]", info);
});

/* =========================
   URL GUARD
========================= */
client.on("guildUpdate", async (oldGuild, newGuild) => {
  try {
    if (newGuild.id !== GUILD_ID) return;

    const oldCode = oldGuild.vanityURLCode || vanityCache.get(newGuild.id) || null;
    const newCode = newGuild.vanityURLCode || null;

    if (oldCode === newCode) return;
    if (revertLocks.has(newGuild.id)) return;

    revertLocks.add(newGuild.id);

    const protectedCode =
      vanityCache.get(newGuild.id) ||
      PROTECTED_VANITY ||
      oldCode ||
      null;

    const auditEntry = await fetchExecutorFromAudit(newGuild);
    const executor = auditEntry?.executor || null;

    const actionKey = `${newGuild.id}:${executor?.id || "unknown"}`;
    const lastActionTime = recentActions.get(actionKey) || 0;

    if (Date.now() - lastActionTime < 5000) {
      return;
    }

    recentActions.set(actionKey, Date.now());

    const banReason = `URL Guard: Sunucunun vanity URL'sini değiştirmeye veya silmeye çalıştı. Korunan URL: ${protectedCode || "bilinmiyor"}`;

    const banResult = executor
      ? await banExecutor(newGuild, executor, banReason)
      : { ok: false, reason: "Yapan kişi audit log üzerinden bulunamadı." };

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
            ? `<@${executor.id}>\n\`${executor.tag}\`\n\`${executor.id}\``
            : "Bulunamadı",
          inline: true
        },
        {
          name: "Ban Durumu",
          value: banResult.ok
            ? "✅ Başarılı"
            : `❌ Başarısız\n${banResult.reason}`,
          inline: true
        },
        {
          name: "URL Geri Yüklendi",
          value: revertResult.ok
            ? "✅ Evet"
            : `❌ Hayır\n${revertResult.reason}`,
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
        text: `${newGuild.name} • ${nowTr()}`
      })
      .setTimestamp();

    await sendLog(newGuild, embed);

    console.log(
      `[URL GUARD] Değişiklik algılandı | eski=${oldCode} yeni=${newCode} korunan=${protectedCode} yapan=${executor?.tag || "bulunamadı"}`
    );
  } catch (err) {
    console.error("[guildUpdate] Hata:", err);
  } finally {
    setTimeout(() => {
      revertLocks.delete(newGuild.id);
    }, 3000);
  }
});

/* =========================
   PERIODIC SELF-HEAL
========================= */
setInterval(async () => {
  try {
    console.log(`[KEEPALIVE] Bot çalışıyor | ${new Date().toISOString()}`);

    if (!client.isReady()) return;

    await setBotPresence();

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;

    if (VOICE_CHANNEL_ID) {
      const connection = getVoiceConnection(guild.id);
      const broken =
        !connection ||
        connection.state.status === VoiceConnectionStatus.Destroyed ||
        connection.state.status === VoiceConnectionStatus.Disconnected;

      if (broken) {
        console.log("[SELF-HEAL] Ses bağlantısı eksik/kırık, yeniden bağlanılıyor.");
        await joinConfiguredVoice(guild);
      }
    }
  } catch (err) {
    console.error("[SELF-HEAL] Hata:", err);
  }
}, 60_000);

/* =========================
   PROCESS SAFETY
========================= */
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

process.on("uncaughtExceptionMonitor", (err) => {
  console.error("[uncaughtExceptionMonitor]", err);
});

process.on("SIGTERM", () => {
  console.log("[PROCESS] SIGTERM alındı.");
});

process.on("SIGINT", () => {
  console.log("[PROCESS] SIGINT alındı.");
});

/* =========================
   LOGIN
========================= */
client.login(TOKEN).catch((err) => {
  console.error("[LOGIN] Bot giriş yapamadı:", err);
});
