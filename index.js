require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType
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
const PORT = process.env.PORT || 3000;

/* =========================
   WEB SERVER
========================= */
const app = express();

app.get("/", (_, res) => {
  res.status(200).send("URL Guard bot aktif.");
});

app.get("/health", (_, res) => {
  res.status(200).send("OK");
});

app.use((_, res) => {
  res.status(200).send("Bot aktif.");
});

app.listen(PORT, () => {
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
    await sleep(1200);

    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.GuildUpdate,
      limit: 10
    });

    const entry = logs.entries.find((e) => {
      if (!e) return false;
      if (!e.executor) return false;
      if (e.targetId !== guild.id) return false;

      const created = e.createdTimestamp || 0;
      return Date.now() - created < 15000;
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
        reason: "Botun rolü/yetkisi yetmiyor veya hedef sunucu sahibi."
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

async function joinConfiguredVoice(guild) {
  try {
    if (!VOICE_CHANNEL_ID) {
      console.log("[VOICE] VOICE_CHANNEL_ID tanımlı değil, ses kanalına girilmeyecek.");
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

    const existing = getVoiceConnection(guild.id);
    if (existing) {
      try {
        existing.destroy();
      } catch {}
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15000);
      console.log(`[VOICE] Otomatik olarak "${channel.name}" kanalına katıldı.`);
    } catch (err) {
      console.error("[VOICE] Bağlantı ready olmadı:", err);
    }

    connection.on("stateChange", async (_, newState) => {
      try {
        if (
          newState.status === VoiceConnectionStatus.Disconnected ||
          newState.status === VoiceConnectionStatus.Destroyed
        ) {
          console.log("[VOICE] Ses bağlantısı koptu, tekrar bağlanılıyor...");
          await sleep(5000);

          const retry = getVoiceConnection(guild.id);
          if (!retry || retry.state.status === VoiceConnectionStatus.Destroyed) {
            await joinConfiguredVoice(guild);
          }
        }
      } catch (err) {
        console.error("[VOICE] Yeniden bağlanma hatası:", err);
      }
    });
  } catch (err) {
    console.error("[VOICE] Ses kanalına giriş hatası:", err);
  }
}

/* =========================
   READY
========================= */
client.once("ready", async () => {
  console.log(`[BOT] ${client.user.tag} olarak giriş yapıldı.`);

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) {
    console.error("[HATA] GUILD_ID ile sunucu bulunamadı.");
    return;
  }

  const fullGuild = await guild.fetch().catch(() => null);
  if (!fullGuild) {
    console.error("[HATA] Sunucu fetch edilemedi.");
    return;
  }

  try {
    await client.user.setPresence({
      status: "invisible"
    });
  } catch (err) {
    console.error("[PRESENCE] Durum ayarlanamadı:", err);
  }

  await initializeProtectedVanity(fullGuild);
  await joinConfiguredVoice(fullGuild);
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
      revertLocks.delete(newGuild.id);
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
   HATA YAKALAMA
========================= */
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

/* =========================
   LOGIN
========================= */
client.login(TOKEN);