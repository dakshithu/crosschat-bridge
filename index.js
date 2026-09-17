const { chromium } = require('playwright');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const fs = require('fs');

// Configuration — all secrets now come from environment variables.
// Locally: put these in a .env file (loaded via dotenv) and never commit it.
// On GitHub Actions: set them as repository Secrets.
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

// In GitHub Actions there's no display, so this must be headless.
// Locally (for generating/refreshing auth.json) set IS_HEADLESS=false.
const IS_HEADLESS = process.env.IS_HEADLESS !== 'false';

// How the process should end when GitHub Actions is about to kill the job.
// Set by the workflow, in seconds. Defaults to running forever (local use).
const MAX_RUNTIME_SECONDS = parseInt(process.env.MAX_RUNTIME_SECONDS || '0', 10);

// How often to flush the Zoom login session, in ms.
const SESSION_SAVE_INTERVAL_MS = 5 * 60 * 1000;

// Helper function to save both auth.json and auth.b64
async function syncStorageState(context, label = '') {
  try {
    await context.storageState({ path: 'auth.json' });
    const jsonContent = fs.readFileSync('auth.json');
    fs.writeFileSync('auth.b64', jsonContent.toString('base64'), 'utf-8');
    console.log(`[Session] ${label ? label + ': ' : ''}Saved auth.json and synced auth.b64.`);
  } catch (err) {
    console.error(`[Session] Failed to save/sync storage state (${label}):`, err);
  }
}

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.User
  ]
});

const discordMsgTextMap = new Map();

function formatDiscordContent(msg) {
  let content = msg.content || '';

  msg.mentions.users.forEach((user) => {
    const member = msg.guild?.members.cache.get(user.id);
    const name = member?.displayName || user.username;
    content = content.replace(new RegExp(`<@!?${user.id}>`, 'g'), `@${name}`);
  });

  msg.mentions.roles.forEach((role) => {
    content = content.replace(new RegExp(`<@&${role.id}>`, 'g'), `@${role.name}`);
  });

  msg.mentions.channels.forEach((channel) => {
    content = content.replace(new RegExp(`<#${channel.id}>`, 'g'), `#${channel.name}`);
  });

  content = content.replace(/<a?:([a-zA-Z0-9_]+):[0-9]+>/g, ':$1:');
  return content.trim();
}

const discordQueue = [];
let isProcessingDiscordQueue = false;

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
      footer: {
        text: 'Zoom Team Chat • ASPAM SERVER'
      }
    };

    if (attachedImageUrl && !attachedImageUrl.includes('zoom.us/nws/')) {
      embed.image = { url: attachedImageUrl };
    }

    const payload = {
      username: author,
      avatar_url: finalAvatarUrl,
      embeds: [embed]
    };

    try {
      const webhookUrlWithWait = DISCORD_WEBHOOK_URL.includes('?')
        ? `${DISCORD_WEBHOOK_URL}&wait=true`
        : `${DISCORD_WEBHOOK_URL}?wait=true`;

      let res = await fetch(webhookUrlWithWait, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const retryAfter = (data.retry_after ? data.retry_after * 1000 : 2000) + 200;
        console.warn(`Discord rate limited. Retrying in ${retryAfter}ms...`);
        discordQueue.unshift({ author, message, avatarUrl, attachedImageUrl });
        await new Promise((r) => setTimeout(r, retryAfter));
      } else if (res.ok) {
        const createdMsg = await res.json().catch(() => null);
        if (createdMsg && createdMsg.id) {
          discordMsgTextMap.set(createdMsg.id, (message || '[Attachment]').slice(0, 80));
          if (discordMsgTextMap.size > 1000) {
            const oldestKey = discordMsgTextMap.keys().next().value;
            discordMsgTextMap.delete(oldestKey);
          }
        }
        console.log(`[Zoom -> Discord] ${author}: ${message || '[Attachment]'}`);
      } else {
        console.error('Discord Webhook Error Status:', res.status);
      }
    } catch (err) {
      console.error('Failed to dispatch Discord webhook:', err);
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  isProcessingDiscordQueue = false;
}

// Upload Discord media to Catbox to provide a clean direct URL and avoid 400 Payload Too Large
async function uploadToCleanHost(url, filename = 'image.png') {
  try {
    const fileRes = await fetch(url);
    if (!fileRes.ok) return null;

    const arrayBuffer = await fileRes.arrayBuffer();
    const blob = new Blob([arrayBuffer]);

    const formData = new FormData();
    formData.append('reqtype', 'fileupload');
    formData.append('fileToUpload', blob, filename);

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

// Relays Discord messages + re-hosted attachments into Zoom Webhook Cards
async function sendToZoomWebhook(authorName, textContent, replyContext = null, attachments = []) {
  try {
    const subHeadText = replyContext
      ? `Replying to ${replyContext.author}`
      : "via Discord • #general";

    const bodyItems = [];

    // 1. Quoted Reply Snippet
    if (replyContext) {
      bodyItems.push({
        type: "message",
        text: `> *${replyContext.author}:* ${replyContext.snippet}`
      });
    }

    // 2. Message Text Content
    if (textContent) {
      bodyItems.push({
        type: "message",
        text: textContent
      });
    }

    const cardAttachments = [];

    // 3. Process attachments
    for (const att of attachments) {
      const isImage = att.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(att.name || '');
      console.log(`[Attachment] Re-hosting ${att.name || 'file'} to public URL...`);
      const directUrl = await uploadToCleanHost(att.url, att.name || 'image.png');
      const finalUrl = directUrl || att.url;

      if (isImage) {
        cardAttachments.push({
          img_url: finalUrl,
          ext: att.name ? att.name.split('.').pop() : 'png'
        });
      } else {
        bodyItems.push({
          type: "message",
          text: `📁 **Attachment:** [${att.name || 'Download'}](${finalUrl})`
        });
      }
    }

    // 4. Footer Metadata Fields
    bodyItems.push({
      type: "fields",
      items: [
        {
          key: "Server",
          value: "ASPAM SERVER",
          style: { short: true }
        },
        {
          key: "Time",
          value: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          style: { short: true }
        }
      ]
    });

    const contentPayload = {
      head: {
        text: authorName,
        sub_head: { text: subHeadText },
        style: {
          color: "#5865F2",
          bold: true
        }
      },
      body: bodyItems
    };

    if (cardAttachments.length > 0) {
      contentPayload.attachments = cardAttachments;
    }

    const payload = {
      content: contentPayload
    };

    let res = await fetch(ZOOM_INCOMING_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': ZOOM_VERIFICATION_TOKEN
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      console.log(`[Discord -> Zoom Card] Delivered from ${authorName}`);
    } else {
      const errText = await res.text();
      console.error('Zoom Webhook Error Status:', res.status, errText);
    }
  } catch (err) {
    console.error('Error sending card to Zoom incoming webhook:', err);
  }
}

async function sendReactionToZoom(userName, emojiString, originalSnippet) {
  try {
    const payload = {
      content: {
        head: {
          text: `${userName} reacted ${emojiString}`,
          sub_head: { text: "Reaction via Discord" },
          style: { color: "#FEE75C", bold: true }
        },
        body: [
          {
            type: "message",
            text: originalSnippet ? `> *Reacted to:* ${originalSnippet}` : `Reacted with ${emojiString}`
          }
        ]
      }
    };

    let res = await fetch(ZOOM_INCOMING_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': ZOOM_VERIFICATION_TOKEN
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      console.log(`[Discord Reaction -> Zoom] ${userName} reacted ${emojiString}`);
    }
  } catch (err) {
    console.error('Error sending reaction card to Zoom:', err);
  }
}

async function startBridge() {
  // Decode auth.b64 into auth.json if it exists
  if (fs.existsSync('auth.b64')) {
    try {
      const b64Data = fs.readFileSync('auth.b64', 'utf-8').trim();
      const decodedJson = Buffer.from(b64Data, 'base64').toString('utf-8');
      fs.writeFileSync('auth.json', decodedJson, 'utf-8');
      console.log('[Auth] Decoded auth.b64 into auth.json successfully.');
    } catch (err) {
      console.error('[Auth] Failed to decode auth.b64:', err);
    }
  } else {
    console.warn('[Auth] auth.b64 not found. Falling back to auth.json if present.');
  }

  console.log('Launching Playwright browser...');
  const browser = await chromium.launch({
    headless: IS_HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080'
    ]
  });

  const context = await browser.newContext({
    storageState: fs.existsSync('auth.json') ? 'auth.json' : undefined,
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32'
    });
  });

  let activePage = await context.newPage();

  activePage.on('console', (msg) => {
    const txt = msg.text();
    if (txt.includes('[ZOOM-DOM]')) console.log(txt);
  });

  console.log('Navigating to Zoom Chat invite URL...');
  await activePage.goto(ZOOM_INVITE_URL, { waitUntil: 'domcontentloaded' });
  await activePage.waitForTimeout(2000);

  try {
    const browserLink = activePage.locator('a, button, div, span').filter({
      hasText: /^Open chat from browser$/i
    }).first();
    await browserLink.waitFor({ state: 'visible', timeout: 15000 });
    await browserLink.click({ force: true });
    console.log('Clicked "Open chat from browser"!');
  } catch (err) {
    try {
      const fallbackLink = activePage.locator('a, button').filter({
        hasText: /chat from browser|open chat/i
      }).first();
      await fallbackLink.click({ force: true });
    } catch (_) {}
  }

  console.log('Waiting 60 seconds for chat interface initialization...');
  await activePage.waitForTimeout(60000);

  for (const p of context.pages()) {
    if (p.url().includes('/wc') || p.url().includes('team-chat')) {
      activePage = p;
    }
  }

  await activePage.exposeFunction('queueDiscordMessage', (author, message, avatarUrl, attachedImageUrl) => {
    const cleanAuthor = author.toLowerCase();
    if ((!message && !attachedImageUrl) || cleanAuthor.includes('webhook') || cleanAuthor.includes('bot') || cleanAuthor.includes('incoming')) {
      return;
    }
    discordQueue.push({ author, message, avatarUrl, attachedImageUrl });
    processDiscordQueue();
  });

  const frames = activePage.frames();
  let targetFrame = activePage;
  const chatIframe = frames.find((f) => f.name() === 'chat' || f.url().includes('chat'));
  if (chatIframe) {
    targetFrame = chatIframe;
    console.log('Attached to Chat Frame.');
  }

  await targetFrame.evaluate(() => {
    let isReady = false;
    let lastKnownAuthor = 'Zoom Member';
    let lastKnownAvatar = '';

    const processedNodes = new WeakSet();
    const seenElementIds = new Set();
    let lastDispatchedText = '';
    let lastDispatchedAuthor = '';
    let lastDispatchedTime = 0;

    function parseItem(item) {
      const fullText = item.innerText?.trim() || '';
      const textLower = fullText.toLowerCase();

      if (
        textLower.includes('incoming webhook') ||
        textLower.includes('via discord') ||
        textLower.includes('aspam server') ||
        item.querySelector('.zds-tag, [class*="appTag"], [class*="_bot_"]') ||
        fullText.startsWith('IW\n')
      ) {
        return { isBot: true, author: '', messageText: '', avatarUrl: '', attachedImageUrl: '' };
      }

      // 1. Author Avatar
      let avatarUrl = '';
      const avatarImg = item.querySelector('img.MuiAvatar-img, img[class*="Avatar"]');
      if (avatarImg && avatarImg.src && avatarImg.src.startsWith('http') && !avatarImg.src.includes('data:image')) {
        avatarUrl = avatarImg.src;
      }

      // 2. Chat Attachments (Images)
      let attachedImageUrl = '';
      const contentImgs = Array.from(item.querySelectorAll('img')).filter(img =>
        !img.className.includes('MuiAvatar') &&
        !img.className.includes('Avatar') &&
        img.src && img.src.startsWith('http') &&
        !img.src.includes('data:image/svg')
      );
      if (contentImgs.length > 0) {
        attachedImageUrl = contentImgs[0].src;
      }

      // 3. Sender Header & Text Segmentation
      const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
      let detectedAuthor = '';
      let bodyStartIndex = 0;

      const hasInitials = lines.length >= 2 && lines[0].length <= 3 && lines[0] === lines[0].toUpperCase() && !lines[0].match(/[0-9]/);
      const timestampIndex = lines.findIndex((l, idx) => idx <= 3 && l.match(/^[（\(]?[0-9]{1,2}:[0-9]{2}(\s*[AP]M)?[）\)]?$/i));

      if (timestampIndex > 0) {
        detectedAuthor = lines[timestampIndex - 1];
        bodyStartIndex = timestampIndex + 1;
      } else if (hasInitials) {
        detectedAuthor = lines[1];
        bodyStartIndex = 2;
      }

      let messageLines = [];
      if (detectedAuthor) {
        messageLines = lines.slice(bodyStartIndex);
      } else {
        messageLines = lines;
      }

      const messageText = messageLines.join('\n').trim();

      let author = '';
      if (detectedAuthor) {
        author = detectedAuthor;
        lastKnownAuthor = detectedAuthor;
        lastKnownAvatar = avatarUrl || '';
      } else {
        author = lastKnownAuthor;
        avatarUrl = lastKnownAvatar;
      }

      return { isBot: false, author, messageText, avatarUrl, attachedImageUrl };
    }

    function processMessageElement(el) {
      if (processedNodes.has(el)) return;

      const { isBot, author, messageText, avatarUrl, attachedImageUrl } = parseItem(el);
      if (isBot || (!messageText && !attachedImageUrl)) return;

      const cleanAuth = author.toLowerCase();
      if (cleanAuth.includes('incoming webhook') || cleanAuth.includes('bot')) return;

      const domMsgId = el.getAttribute('id') || 
                       el.getAttribute('data-id') || 
                       el.getAttribute('data-msg-id') || 
                       el.querySelector('[id*="msg"]')?.getAttribute('id');

      const now = Date.now();

      if (domMsgId) {
        if (seenElementIds.has(domMsgId)) return;
        seenElementIds.add(domMsgId);
        if (seenElementIds.size > 1000) {
          const oldest = seenElementIds.values().next().value;
          seenElementIds.delete(oldest);
        }
      } else {
        const isIdentical = (author === lastDispatchedAuthor && messageText === lastDispatchedText);
        const timeDiff = now - lastDispatchedTime;

        if (isIdentical && timeDiff < 40) {
          return;
        }
      }

      processedNodes.add(el);
      lastDispatchedAuthor = author;
      lastDispatchedText = messageText;
      lastDispatchedTime = now;

      console.log(`[ZOOM-DOM] Captured message from ${author}: ${messageText || '[Attachment]'}`);
      window.queueDiscordMessage(author, messageText, avatarUrl, attachedImageUrl);
    }

    document.querySelectorAll('div[class*="_chatMessage_"]').forEach((el) => {
      processedNodes.add(el);
      const domMsgId = el.getAttribute('id') || el.getAttribute('data-id') || el.getAttribute('data-msg-id');
      if (domMsgId) seenElementIds.add(domMsgId);
    });

    setTimeout(() => {
      isReady = true;
      console.log('[ZOOM-DOM] High-speed observer active.');
    }, 3000);

    const observer = new MutationObserver((mutations) => {
      if (!isReady) return;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.className && typeof node.className === 'string' && node.className.includes('_chatMessage_')) {
              processMessageElement(node);
            } else if (node.querySelectorAll) {
              const items = node.querySelectorAll('div[class*="_chatMessage_"]');
              for (let i = 0; i < items.length; i++) {
                processMessageElement(items[i]);
              }
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });

  // DISCORD -> ZOOM RELAY
  discordClient.on('messageCreate', async (msg) => {
    if (msg.webhookId || msg.author.bot) return;
    if (msg.channel.id !== DISCORD_CHANNEL_ID) return;

    const displayName = msg.member?.displayName || msg.author.displayName || msg.author.globalName || msg.author.username;
    const cleanText = formatDiscordContent(msg);

    const attachments = Array.from(msg.attachments.values()).map(a => ({
      url: a.url,
      name: a.name,
      contentType: a.contentType
    }));

    if (!cleanText && attachments.length === 0) return;

    discordMsgTextMap.set(msg.id, (cleanText || (attachments.length ? `[Attachment: ${attachments[0].name}]` : '')).slice(0, 80));

    let replyContext = null;
    if (msg.reference?.messageId) {
      try {
        const repliedMsg = await msg.channel.messages.fetch(msg.reference.messageId);
        const repliedAuthor = repliedMsg.member?.displayName || repliedMsg.author.displayName || repliedMsg.author.username;
        const rawContent = repliedMsg.cleanContent || repliedMsg.embeds?.[0]?.description || '';
        const snippet = rawContent.slice(0, 60) + (rawContent.length > 60 ? '...' : '');
        replyContext = { author: repliedAuthor, snippet };
      } catch (_) {}
    }

    console.log(`[Discord -> Zoom] Dispatching message from ${displayName}`);
    await sendToZoomWebhook(displayName, cleanText, replyContext, attachments);
  });

  // DISCORD REACTION -> ZOOM RELAY
  discordClient.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.message.channelId !== DISCORD_CHANNEL_ID) return;

    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
      if (user.partial) await user.fetch();

      const guild = reaction.message.guild;
      const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
      const userName = member?.displayName || user.displayName || user.username;

      const emojiStr = reaction.emoji.id
        ? `<:${reaction.emoji.name}:${reaction.emoji.id}>`
        : (reaction.emoji.name || '👍');

      const originalText = discordMsgTextMap.get(reaction.message.id)
        || reaction.message.cleanContent?.slice(0, 60)
        || reaction.message.embeds?.[0]?.description?.slice(0, 60)
        || '';

      console.log(`[Discord Reaction] ${userName} reacted ${emojiStr}`);
      await sendReactionToZoom(userName, emojiStr, originalText);
    } catch (err) {
      console.error('Error handling reaction event:', err);
    }
  });

  await discordClient.login(DISCORD_BOT_TOKEN);
  console.log('Two-way Discord <-> Zoom bridge is active!');

  // Save initial auth checkpoint
  await syncStorageState(context, 'Initial checkpoint');

  // Periodically save the Zoom login session
  const saveInterval = setInterval(async () => {
    await syncStorageState(context, 'Periodic interval');
  }, SESSION_SAVE_INTERVAL_MS);

  async function shutdown(reason) {
    console.log(`Shutting down (${reason})...`);
    clearInterval(saveInterval);
    await syncStorageState(context, 'Final shutdown');

    try {
      await browser.close();
    } catch (_) {}
    try {
      discordClient.destroy();
    } catch (_) {}
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  if (MAX_RUNTIME_SECONDS > 0) {
    console.log(`Will self-restart after ${MAX_RUNTIME_SECONDS}s to stay under the job time limit.`);
    setTimeout(() => shutdown('scheduled restart'), MAX_RUNTIME_SECONDS * 1000);
  }
}

startBridge().catch(console.error);
