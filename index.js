const { chromium } = require('playwright');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const fs = require('fs');

require('dotenv').config();

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

const DISCORD_BOT_TOKEN = requireEnv('DISCORD_BOT_TOKEN');
const DISCORD_CHANNEL_ID = requireEnv('DISCORD_CHANNEL_ID');
const DISCORD_WEBHOOK_URL = requireEnv('DISCORD_WEBHOOK_URL');
const ZOOM_INVITE_URL = requireEnv('ZOOM_INVITE_URL');
const ZOOM_VERIFICATION_TOKEN = requireEnv('ZOOM_VERIFICATION_TOKEN');
let RAW_ZOOM_URL = requireEnv('ZOOM_INCOMING_WEBHOOK_URL_RAW');
const ZOOM_INCOMING_WEBHOOK_URL = RAW_ZOOM_URL.includes('format=')
  ? RAW_ZOOM_URL
  : `${RAW_ZOOM_URL}${RAW_ZOOM_URL.includes('?') ? '&' : '?'}format=full`;

const IS_HEADLESS = process.env.IS_HEADLESS !== 'false';
const discordMsgTextMap = new Map();
const discordQueue = [];
let isProcessingDiscordQueue = false;

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
});

function formatDiscordContent(msg) {
  let content = msg.content || '';
  msg.mentions.users.forEach((user) => {
    const member = msg.guild?.members.cache.get(user.id);
    content = content.replace(new RegExp(`<@!?${user.id}>`, 'g'), `@${member?.displayName || user.username}`);
  });
  msg.mentions.roles.forEach((role) => {
    content = content.replace(new RegExp(`<@&${role.id}>`, 'g'), `@${role.name}`);
  });
  msg.mentions.channels.forEach((channel) => {
    content = content.replace(new RegExp(`<#${channel.id}>`, 'g'), `#${channel.name}`);
  });
  return content.replace(/<a?:([a-zA-Z0-9_]+):[0-9]+>/g, ':$1:').trim();
}

async function processDiscordQueue() {
  if (isProcessingDiscordQueue || discordQueue.length === 0) return;
  isProcessingDiscordQueue = true;

  while (discordQueue.length > 0) {
    const { author, message, avatarUrl, attachedImageUrl } = discordQueue.shift();
    const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(author)}&background=2D8CFF&color=fff&rounded=true&bold=true`;
    const finalAvatarUrl = (avatarUrl && avatarUrl.startsWith('http')) ? avatarUrl : fallbackAvatar;

    let cleanMessage = message || '';
    if (attachedImageUrl && !cleanMessage) {
      cleanMessage = `📎 Shared an image: ${attachedImageUrl}`;
    } else if (attachedImageUrl) {
      cleanMessage += `\n📎 ${attachedImageUrl}`;
    }

    const embed = {
      description: cleanMessage,
      color: 0x2D8CFF,
      timestamp: new Date().toISOString(),
      footer: { text: 'Zoom Team Chat' }
    };

    if (attachedImageUrl && !attachedImageUrl.includes('zoom.us/nws/')) {
      embed.image = { url: attachedImageUrl };
    }

    try {
      const webhookUrlWithWait = DISCORD_WEBHOOK_URL.includes('?')
        ? `${DISCORD_WEBHOOK_URL}&wait=true`
        : `${DISCORD_WEBHOOK_URL}?wait=true`;

      let res = await fetch(webhookUrlWithWait, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: author,
          avatar_url: finalAvatarUrl,
          embeds: [embed]
        })
      });

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const retryAfter = (data.retry_after ? data.retry_after * 1000 : 2000) + 200;
        discordQueue.unshift({ author, message, avatarUrl, attachedImageUrl });
        await new Promise((r) => setTimeout(r, retryAfter));
      } else if (res.ok) {
        console.log(`[Zoom -> Discord] ${author}: ${message || '[Attachment]'}`);
      }
    } catch (err) {
      console.error('Failed to dispatch Discord webhook:', err);
    }

    await new Promise((r) => setTimeout(r, 250));
  }
  isProcessingDiscordQueue = false;
}

async function uploadToCleanHost(url, filename = 'image.png') {
  try {
    const fileRes = await fetch(url);
    if (!fileRes.ok) return null;
    const arrayBuffer = await fileRes.arrayBuffer();
    const formData = new FormData();
    formData.append('reqtype', 'fileupload');
    formData.append('fileToUpload', new Blob([arrayBuffer]), filename);

    const uploadRes = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      body: formData
    });

    if (uploadRes.ok) {
      const cleanUrl = (await uploadRes.text()).trim();
      if (cleanUrl.startsWith('http')) return cleanUrl;
    }
  } catch (err) {
    console.error('Failed to re-host attachment:', err);
  }
  return null;
}

async function sendToZoomWebhook(authorName, textContent, attachments = []) {
  try {
    const bodyItems = [];
    if (textContent) bodyItems.push({ type: "message", text: textContent });

    const cardAttachments = [];
    for (const att of attachments) {
      const isImage = att.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(att.name || '');
      const directUrl = await uploadToCleanHost(att.url, att.name || 'image.png');
      const finalUrl = directUrl || att.url;

      if (isImage) {
        cardAttachments.push({ img_url: finalUrl, ext: att.name ? att.name.split('.').pop() : 'png' });
      } else {
        bodyItems.push({ type: "message", text: `📁 **Attachment:** [${att.name || 'Download'}](${finalUrl})` });
      }
    }

    bodyItems.push({
      type: "fields",
      items: [
        { key: "Platform", value: "Discord", style: { short: true } },
        { key: "Time", value: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), style: { short: true } }
      ]
    });

    const payload = {
      content: {
        head: { text: authorName, sub_head: { text: "via Discord" }, style: { color: "#5865F2", bold: true } },
        body: bodyItems,
        ...(cardAttachments.length > 0 && { attachments: cardAttachments })
      }
    };

    await fetch(ZOOM_INCOMING_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': ZOOM_VERIFICATION_TOKEN },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('Error sending card to Zoom webhook:', err);
  }
}

async function startBridge() {
  if (fs.existsSync('auth.b64')) {
    try {
      const b64Data = fs.readFileSync('auth.b64', 'utf-8').trim();
      fs.writeFileSync('auth.json', Buffer.from(b64Data, 'base64').toString('utf-8'), 'utf-8');
    } catch (err) {
      console.error('[Auth] Failed to decode auth.b64:', err);
    }
  }

  const browser = await chromium.launch({
    headless: IS_HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    storageState: fs.existsSync('auth.json') ? 'auth.json' : undefined,
    viewport: { width: 1920, height: 1080 }
  });

  let activePage = await context.newPage();

  activePage.on('console', (msg) => {
    const txt = msg.text();
    if (txt.includes('[ZOOM-DOM]')) console.log(txt);
  });

  console.log('Navigating to Zoom Chat...');
  await activePage.goto(ZOOM_INVITE_URL, { waitUntil: 'networkidle' });

  try {
    const browserLink = activePage.locator('text=/Open chat from browser|open chat/i').first();
    await browserLink.waitFor({ state: 'visible', timeout: 10000 });
    await browserLink.click({ force: true });
  } catch (_) {}

  // Wait for the chat container to mount
  console.log('Waiting for chat view to load...');
  await activePage.waitForTimeout(15000);

  // Expose the queue callback globally on the page context
  await activePage.exposeFunction('queueDiscordMessage', (author, message, avatarUrl, attachedImageUrl) => {
    const cleanAuthor = (author || '').toLowerCase();
    if ((!message && !attachedImageUrl) || cleanAuthor.includes('webhook') || cleanAuthor.includes('bot')) return;
    discordQueue.push({ author, message, avatarUrl, attachedImageUrl });
    processDiscordQueue();
  });

  // Inject observer into all present and future frames
  async function attachObserver(frame) {
    try {
      await frame.evaluate(() => {
        if (window.__zoomBridgeActive) return;
        window.__zoomBridgeActive = true;

        const seenItems = new Set();
        let lastAuthor = 'Zoom Member';

        function checkNode(el) {
          if (!el || el.nodeType !== Node.ELEMENT_NODE) return;

          // Target list items, message rows, or container blocks
          const isMsgRow = el.matches('[role="row"], [role="listitem"], div[data-testid*="message"], div[class*="chatMessage"], div[class*="message-item"]');
          const target = isMsgRow ? el : el.querySelector('[role="row"], [role="listitem"], div[data-testid*="message"], div[class*="chatMessage"]');

          if (!target) return;

          const text = target.innerText?.trim() || '';
          if (!text || seenItems.has(text)) return;
          if (text.toLowerCase().includes('via discord') || text.toLowerCase().includes('incoming webhook')) return;

          // Extract sender and content
          const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
          let author = lastAuthor;
          let body = text;

          if (lines.length >= 2) {
            // Usually [Name, Time, Text...] or [Initials, Name, Time, Text...]
            const timeIdx = lines.findIndex(l => /^[0-9]{1,2}:[0-9]{2}(\s*[AP]M)?$/i.test(l));
            if (timeIdx > 0) {
              author = lines[timeIdx - 1];
              body = lines.slice(timeIdx + 1).join('\n');
            } else {
              author = lines[0];
              body = lines.slice(1).join('\n');
            }
          }

          lastAuthor = author;
          seenItems.add(text);
          if (seenItems.size > 500) seenItems.delete(seenItems.values().next().value);

          const img = target.querySelector('img:not([class*="avatar"])');
          const avatar = target.querySelector('img[class*="avatar"]')?.src || '';

          console.log(`[ZOOM-DOM] Extracted: ${author}: ${body}`);
          if (window.queueDiscordMessage) {
            window.queueDiscordMessage(author, body, avatar, img?.src || '');
          }
        }

        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const n of m.addedNodes) checkNode(n);
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        console.log('[ZOOM-DOM] Observer attached to frame:', window.location.href);
      });
    } catch (_) {}
  }

  // Bind to current frames and handle navigation
  for (const f of activePage.frames()) await attachObserver(f);
  activePage.on('frameattached', async (f) => await attachObserver(f));

  // DISCORD -> ZOOM RELAY
  discordClient.on('messageCreate', async (msg) => {
    if (msg.webhookId || msg.author.bot || msg.channel.id !== DISCORD_CHANNEL_ID) return;
    const authorName = msg.member?.displayName || msg.author.username;
    const cleanText = formatDiscordContent(msg);
    const attachments = Array.from(msg.attachments.values()).map(a => ({
      url: a.url,
      name: a.name,
      contentType: a.contentType
    }));

    if (!cleanText && attachments.length === 0) return;
    await sendToZoomWebhook(authorName, cleanText, attachments);
  });

  await discordClient.login(DISCORD_BOT_TOKEN);
  console.log('[Bridge] Ready and listening both ways.');
}

startBridge();
