/* =========================================================
   Working WaToTg By @Cdh4cks
========================================================= */

require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const { Telegraf, Markup } = require('telegraf');

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const readline = require('readline');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
    console.error('❌ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in .env');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const messageStore = new Map();

const SCHEDULE_FILE = path.join(__dirname, 'schedules.json');
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const PAIRING_FILE = path.join(__dirname, '.pairing_phone');

let activeSock = null;
let botStarted = false;
let whatsappStarting = false;
let pairingPhoneNumber = '';
let hasSentStartupMessage = false; // 🔥 Spaming rokne ke liye flag

const scheduleTimers = new Map();
const scheduleRetryTimers = new Map();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (text) => new Promise((resolve) => rl.question(text, resolve));


/* =========================================================
   HELPERS
========================================================= */

function cleanText(text) {
    if (!text) return '';
    return String(text).replace(/[*_`[\]]/g, '');
}

function normalizeNumber(number) {
    return String(number || '').replace(/\D/g, '');
}

function isValidPhoneNumber(number) {
    const value = normalizeNumber(number);
    return value.length >= 8 && value.length <= 15;
}

function jidFromNumber(number) {
    return `${normalizeNumber(number)}@s.whatsapp.net`;
}


/* =========================================================
   STORAGE
========================================================= */

function loadPairingPhone() {
    try {
        if (fs.existsSync(PAIRING_FILE)) {
            return normalizeNumber(fs.readFileSync(PAIRING_FILE, 'utf8'));
        }
    } catch (err) {}
    return '';
}

function savePairingPhone(number) {
    try {
        fs.writeFileSync(PAIRING_FILE, normalizeNumber(number), 'utf8');
    } catch (err) {}
}

function clearPairingPhone() {
    pairingPhoneNumber = '';
    try {
        if (fs.existsSync(PAIRING_FILE)) fs.unlinkSync(PAIRING_FILE);
    } catch (err) {}
}

function loadSchedules() {
    try {
        if (!fs.existsSync(SCHEDULE_FILE)) return [];
        const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch (err) {
        return [];
    }
}

function saveSchedules(schedules) {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedules, null, 2));
}


/* =========================================================
   TELEGRAM SENDER
========================================================= */

async function sendToTelegramDirect(type, data, caption) {
    if (type === 'text') {
        await bot.telegram.sendMessage(CHAT_ID, data, { parse_mode: 'Markdown' });
        return;
    }

    const ext = type === 'imageMessage' ? 'jpg' : type === 'videoMessage' ? 'mp4' : type === 'audioMessage' ? 'ogg' : 'bin';
    const tempFilePath = path.join(__dirname, `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);

    try {
        await fs.promises.writeFile(tempFilePath, data);
        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        if (caption) {
            form.append('caption', caption);
            form.append('parse_mode', 'Markdown');
        }

        let apiMethod = 'sendDocument';
        let fieldName = 'document';

        if (type === 'imageMessage') {
            apiMethod = 'sendPhoto';
            fieldName = 'photo';
        } else if (type === 'videoMessage') {
            apiMethod = 'sendVideo';
            fieldName = 'video';
        } else if (type === 'audioMessage') {
            apiMethod = 'sendAudio';
            fieldName = 'audio';
        }

        form.append(fieldName, fs.createReadStream(tempFilePath));

        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/${apiMethod}`, form, {
            headers: form.getHeaders(),
            timeout: 120000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
    } catch (err) {
    } finally {
        try {
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        } catch (_) {}
    }
}


/* =========================================================
   SCHEDULE TIMERS
========================================================= */

function clearScheduleTimer(id) {
    const timer = scheduleTimers.get(id);
    if (timer) {
        clearTimeout(timer);
        scheduleTimers.delete(id);
    }
    const retry = scheduleRetryTimers.get(id);
    if (retry) {
        clearTimeout(retry);
        scheduleRetryTimers.delete(id);
    }
}

function scheduleTimer(item) {
    clearScheduleTimer(item.id);
    if (item.status !== 'pending') return;

    const target = new Date(item.datetime).getTime();
    if (!Number.isFinite(target)) return;

    const remaining = target - Date.now();
    if (remaining <= 0) {
        void sendScheduledMessage(item.id);
        return;
    }

    const delay = Math.min(remaining, 2147483647);
    const timer = setTimeout(() => {
        const current = loadSchedules().find(x => x.id === item.id);
        if (!current || current.status !== 'pending') return;

        const left = new Date(current.datetime).getTime() - Date.now();
        if (left <= 0) {
            void sendScheduledMessage(current.id);
        } else {
            scheduleTimer(current);
        }
    }, delay);

    scheduleTimers.set(item.id, timer);
}

function retrySchedule(id, delay = 10000) {
    clearScheduleTimer(id);
    const timer = setTimeout(() => {
        scheduleRetryTimers.delete(id);
        const current = loadSchedules().find(x => x.id === id);
        if (current && current.status === 'pending') {
            scheduleTimer(current);
        }
    }, delay);

    scheduleRetryTimers.set(id, timer);
}

async function sendScheduledMessage(id) {
    clearScheduleTimer(id);
    const schedules = loadSchedules();
    const item = schedules.find(x => x.id === id);

    if (!item || item.status !== 'pending') return;
    if (!activeSock) {
        retrySchedule(id, 10000);
        return;
    }

    try {
        const number = normalizeNumber(item.number);
        if (!isValidPhoneNumber(number)) throw new Error('Invalid number');

        item.status = 'sending';
        item.lastAttemptAt = new Date().toISOString();
        saveSchedules(schedules);

        const jid = jidFromNumber(number);

        if (item.mediaPath && fs.existsSync(item.mediaPath)) {
            const mediaBuffer = fs.readFileSync(item.mediaPath);
            if (item.mediaType === 'image') {
                await activeSock.sendMessage(jid, { image: mediaBuffer, caption: item.message || '' });
            } else if (item.mediaType === 'video') {
                await activeSock.sendMessage(jid, { video: mediaBuffer, caption: item.message || '' });
            } else if (item.mediaType === 'document') {
                await activeSock.sendMessage(jid, { document: mediaBuffer, mimetype: 'application/octet-stream', fileName: 'file', caption: item.message || '' });
            }
        } else {
            await activeSock.sendMessage(jid, { text: item.message });
        }

        item.status = 'sent';
        item.sentAt = new Date().toISOString();
        delete item.lastError;
        saveSchedules(schedules);

        await bot.telegram.sendMessage(
            CHAT_ID,
            [
                '✨ *Scheduled Message Sent* ✨',
                '',
                `📱 To: \`${item.number}\``,
                `📅 Date: ${item.date}`,
                `⏰ Time: ${item.time}`,
                `💬 Message: ${item.message || '(Media Only)'}`
            ].join('\n'),
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        const currentSchedules = loadSchedules();
        const current = currentSchedules.find(x => x.id === id);
        if (current) {
            current.status = 'pending';
            current.lastError = error.message;
            saveSchedules(currentSchedules);
        }
        retrySchedule(id, 10000);
    }
}

function loadAllScheduleTimers() {
    const schedules = loadSchedules();
    let changed = false;

    for (const item of schedules) {
        if (item.status === 'sending') {
            item.status = 'pending';
            changed = true;
        }
        if (item.status === 'pending') {
            scheduleTimer(item);
        }
    }
    if (changed) saveSchedules(schedules);
}


/* =========================================================
   WIZARD & UI
========================================================= */

function isAllowedChat(ctx) {
    return String(ctx.chat?.id) === String(CHAT_ID);
}

const scheduleSessions = new Map();

function startSchedule(ctx) {
    scheduleSessions.set(String(ctx.chat.id), { step: 'number', data: {} });
    return ctx.reply('✨ *WhatsApp Scheduler* ✨\n\n📱 Enter WhatsApp number with country code (e.g., `919876543210`):', { parse_mode: 'Markdown' });
}

function getQuickDates() {
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    const formatDate = (d) => d.toISOString().split('T')[0];
    return { todayStr: formatDate(today), tomorrowStr: formatDate(tomorrow) };
}

async function handleScheduleInput(ctx) {
    const chatId = String(ctx.chat.id);
    const session = scheduleSessions.get(chatId);
    if (!session) return false;

    const input = String(ctx.message?.text || '').trim();
    const hasPhoto = ctx.message?.photo;
    const hasDocument = ctx.message?.document;
    const hasVideo = ctx.message?.video;

    if (session.step === 'number') {
        const number = normalizeNumber(input);
        if (!isValidPhoneNumber(number)) {
            await ctx.reply('❌ Invalid number. Example: `919876543210`', { parse_mode: 'Markdown' });
            return true;
        }
        session.data.number = number;
        session.step = 'date';
        const { todayStr, tomorrowStr } = getQuickDates();
        await ctx.reply('📅 *Select Date:*', {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(`🟢 Today (${todayStr})`, `date_${todayStr}`)],
                [Markup.button.callback(`🔵 Tomorrow (${tomorrowStr})`, `date_${tomorrowStr}`)]
            ])
        });
        return true;
    }

    if (session.step === 'date') {
        if (!/^(\d{4})-(\d{2})-(\d{2})$/.test(input)) {
            await ctx.reply('❌ Use `YYYY-MM-DD` format or click a button.', { parse_mode: 'Markdown' });
            return true;
        }
        session.data.date = input;
        session.step = 'time';
        await ctx.reply('⏰ *Select Time:*', {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🎂 Birthday 12:00 AM', 'time_00:00')],
                [Markup.button.callback('09:00 AM', 'time_09:00'), Markup.button.callback('12:00 PM', 'time_12:00')],
                [Markup.button.callback('03:00 PM', 'time_15:00'), Markup.button.callback('06:00 PM', 'time_18:00')],
                [Markup.button.callback('09:00 PM', 'time_21:00'), Markup.button.callback('11:59 PM', 'time_23:59')]
            ])
        });
        return true;
    }

    if (session.step === 'time') {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input)) {
            await ctx.reply('❌ Use `HH:MM` format or click a button.', { parse_mode: 'Markdown' });
            return true;
        }
        session.data.time = input;
        session.step = 'message';
        await ctx.reply('💬 *Enter message or send media (Photo/Video/Document):*', { parse_mode: 'Markdown' });
        return true;
    }

    if (session.step === 'message') {
        let messageText = input;
        let mediaType = null;
        let savedMediaPath = null;

        if (hasPhoto || hasDocument || hasVideo) {
            const fileId = hasPhoto ? ctx.message.photo[ctx.message.photo.length - 1].file_id :
                           hasVideo ? ctx.message.video.file_id : ctx.message.document.file_id;
            
            mediaType = hasPhoto ? 'image' : hasVideo ? 'video' : 'document';
            messageText = ctx.message.caption || '';

            const fileLink = await bot.telegram.getFileLink(fileId);
            const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
            
            const uploadDir = path.join(__dirname, 'scheduled_media');
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
            
            savedMediaPath = path.join(uploadDir, `media_${Date.now()}.${mediaType === 'image' ? 'jpg' : mediaType === 'video' ? 'mp4' : 'bin'}`);
            fs.writeFileSync(savedMediaPath, Buffer.from(response.data));
        }

        session.data.message = messageText;
        session.data.mediaType = mediaType;
        session.data.mediaPath = savedMediaPath;

        const datetime = `${session.data.date}T${session.data.time}:00`;
        const target = new Date(datetime).getTime();

        if (!Number.isFinite(target) || target <= Date.now()) {
            await ctx.reply('❌ Past time cannot be scheduled.');
            scheduleSessions.delete(chatId);
            return true;
        }

        const schedules = loadSchedules();
        const item = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            number: session.data.number,
            date: session.data.date,
            time: session.data.time,
            datetime,
            message: session.data.message,
            mediaType: session.data.mediaType,
            mediaPath: session.data.mediaPath,
            status: 'pending',
            createdAt: new Date().toISOString()
        };

        schedules.push(item);
        saveSchedules(schedules);
        scheduleTimer(item);
        scheduleSessions.delete(chatId);

        await ctx.reply(
            [
                '✅ *SUCCESSFULLY SCHEDULED*',
                '',
                `🆔 ID: \`${item.id}\``,
                `📱 To: \`${item.number}\``,
                `📅 Date: ${item.date} | ⏰ Time: ${item.time}`,
                `💬 Text: ${item.message || '(Media Attached)'}`
            ].join('\n'),
            { parse_mode: 'Markdown' }
        );
        return true;
    }
    return true;
}

bot.action(/^date_(.+)$/, async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();
    const session = scheduleSessions.get(String(ctx.chat.id));
    if (!session || session.step !== 'date') return;
    session.data.date = ctx.match[1];
    session.step = 'time';
    await ctx.editMessageText(`📅 Date: *${session.data.date}*\n\n⏰ *Select Time:*`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🎂 Birthday 12:00 AM', 'time_00:00')],
            [Markup.button.callback('09:00 AM', 'time_09:00'), Markup.button.callback('12:00 PM', 'time_12:00')],
            [Markup.button.callback('03:00 PM', 'time_15:00'), Markup.button.callback('06:00 PM', 'time_18:00')],
            [Markup.button.callback('09:00 PM', 'time_21:00'), Markup.button.callback('11:59 PM', 'time_23:59')]
        ])
    });
});

bot.action(/^time_(.+)$/, async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();
    const session = scheduleSessions.get(String(ctx.chat.id));
    if (!session || session.step !== 'time') return;
    session.data.time = ctx.match[1];
    session.step = 'message';
    await ctx.editMessageText(`⏰ Time: *${session.data.time}*\n\n💬 *Send message or media now:*`, { parse_mode: 'Markdown' });
});


/* =========================================================
   TELEGRAM COMMANDS
========================================================= */

bot.start(async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.reply('🤖 *Working WaToTg By @Cdh4cks* 🚀', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📅 Schedule Message', 'btn_schedule'), Markup.button.callback('📋 List Schedules', 'btn_list')],
            [Markup.button.callback('📊 Bot Status', 'btn_status'), Markup.button.callback('💾 Backup Data', 'btn_backup')],
            [Markup.button.callback('❌ Cancel', 'btn_cancel')]
        ])
    });
});

bot.action('btn_schedule', async (ctx) => { if (isAllowedChat(ctx)) { await ctx.answerCbQuery(); await startSchedule(ctx); } });
bot.action('btn_list', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();
    const schedules = loadSchedules();
    if (!schedules.length) return ctx.reply('📭 No schedules found.');
    const kb = [];
    const lines = ['✨ *SCHEDULED MESSAGES* ✨\n'];
    schedules.forEach(i => {
        lines.push(`🆔 \`${i.id}\`\n📱 \`${i.number}\` | 📅 ${i.date} ${i.time}\n💬 ${i.message || '(Media)'}\n📌 **${i.status}**\n---`);
        if (i.status === 'pending') kb.push([Markup.button.callback(`❌ Delete ${i.id}`, `del_${i.id}`)]);
    });
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', ...Markup.inlineKeyboard(kb) });
});

bot.action(/^del_(.+)$/, async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    clearScheduleTimer(id);
    const schedules = loadSchedules();
    const index = schedules.findIndex(x => x.id === id);
    if (index !== -1) {
        schedules.splice(index, 1);
        saveSchedules(schedules);
        await ctx.reply(`✅ Deleted ID: \`${id}\``, { parse_mode: 'Markdown' });
    }
});

bot.action('btn_status', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();
    const s = loadSchedules();
    await ctx.reply(`🤖 *Status*\nWhatsApp: ${activeSock ? '🟢 Online' : '🔴 Offline'}\nPending: ${s.filter(x => x.status === 'pending').length}`, { parse_mode: 'Markdown' });
});

bot.action('btn_backup', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();
    if (fs.existsSync(SCHEDULE_FILE)) await ctx.replyWithDocument({ source: SCHEDULE_FILE }, { caption: '💾 *Backup File*' });
    else await ctx.reply('📭 No data.');
});

bot.action('btn_cancel', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();
    scheduleSessions.delete(String(ctx.chat.id));
    await ctx.reply('❌ Cancelled.');
});

bot.command('schedule', (ctx) => isAllowedChat(ctx) && startSchedule(ctx));
bot.command('list', (ctx) => isAllowedChat(ctx) && bot.handleUpdate({ ...ctx.update, message: { ...ctx.update.message, text: '' } }));
bot.command('backup', (ctx) => isAllowedChat(ctx) && fs.existsSync(SCHEDULE_FILE) && ctx.replyWithDocument({ source: SCHEDULE_FILE }));
bot.command('status', (ctx) => isAllowedChat(ctx) && ctx.reply('🤖 Bot Active'));

bot.on('text', (ctx) => isAllowedChat(ctx) && !ctx.message.text.startsWith('/') && handleScheduleInput(ctx));
bot.on('photo', (ctx) => isAllowedChat(ctx) && handleScheduleInput(ctx));
bot.on('document', (ctx) => isAllowedChat(ctx) && handleScheduleInput(ctx));
bot.on('video', (ctx) => isAllowedChat(ctx) && handleScheduleInput(ctx));

function startTelegramBot() {
    if (botStarted) return;
    botStarted = true;
    bot.launch().catch(() => { botStarted = false; });
}


/* =========================================================
   WHATSAPP BOT & FORWARDER
========================================================= */

async function startBot() {
    if (whatsappStarting) return;
    whatsappStarting = true;

    let state, saveCreds;
    try {
        ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
    } catch (err) {
        whatsappStarting = false;
        setTimeout(() => void startBot(), 5000);
        return;
    }

    let phoneNumber = '';
    if (!state.creds.registered) {
        pairingPhoneNumber = pairingPhoneNumber || loadPairingPhone();
        if (!pairingPhoneNumber) {
            pairingPhoneNumber = normalizeNumber(await question('📱 Enter WhatsApp Phone Number with Country Code: '));
            savePairingPhone(pairingPhoneNumber);
        }
        phoneNumber = pairingPhoneNumber;
    }

    let sock;
    try {
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['WaToTg', 'Chrome', '122.0.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000
        });
    } catch (err) {
        whatsappStarting = false;
        setTimeout(() => void startBot(), 5000);
        return;
    }

    activeSock = sock;
    whatsappStarting = false;

    sock.ev.on('creds.update', saveCreds);

    let codeRequested = false;
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (!state.creds.registered && !codeRequested && phoneNumber) {
            codeRequested = true;
            setTimeout(async () => {
                try {
                    if (state.creds.registered) return;
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n🔑 PAIRING CODE: ${code}\n`);
                } catch (err) { codeRequested = false; }
            }, 6000);
        }

        if (connection === 'close') {
            if (activeSock === sock) activeSock = null;
            if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                clearPairingPhone();
                return;
            }
            setTimeout(() => { if (!activeSock && !whatsappStarting) void startBot(); }, 3000);
        } else if (connection === 'open') {
            activeSock = sock;
            clearPairingPhone();
            console.log('✅ Working WaToTg By @Cdh4cks');
            loadAllScheduleTimers();

            // 🔥 Sirf ek hi baar message jayega jab bot fresh start ya pair hoga
            if (!hasSentStartupMessage) {
                hasSentStartupMessage = true;
                try {
                    await bot.telegram.sendMessage(
                        CHAT_ID,
                        '🤖 *Working WaToTg By @Cdh4cks* 🚀\n\n✅ WhatsApp connected successfully!',
                        {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback('📅 Schedule Message', 'btn_schedule'), Markup.button.callback('📋 List Schedules', 'btn_list')],
                                [Markup.button.callback('📊 Bot Status', 'btn_status'), Markup.button.callback('💾 Backup Data', 'btn_backup')],
                                [Markup.button.callback('❌ Cancel', 'btn_cancel')]
                            ])
                        }
                    );
                } catch (e) {}
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' && m.type !== 'append') return;

        for (const msg of m.messages || []) {
            if (!msg.message) continue;
            const remoteJid = msg.key.remoteJid;
            const isStatus = remoteJid === 'status@broadcast';
            if (!isStatus && msg.key.fromMe) continue;

            const rawSender = remoteJid.replace('@s.whatsapp.net', '');
            const senderName = cleanText(msg.pushName || rawSender);
            const senderInfo = `👤 Name: *${senderName}*\n📱 Number: \`+${rawSender}\``;

            const msgId = msg.key.id;
            const msgType = Object.keys(msg.message)[0];

            try {
                if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
                    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    const formattedText = isStatus
                        ? `📸 *TEXT STATUS*\n${senderInfo}\n💬: ${text}`
                        : `📩 *New Message*\n${senderInfo}\n💬: ${text}`;

                    await sendToTelegramDirect('text', formattedText);
                    messageStore.set(msgId, { type: 'text', data: text, sender: senderName, number: rawSender });
                } else if (['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage'].includes(msgType)) {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                    let caption = isStatus
                        ? `📸 *MEDIA STATUS*\n${senderInfo}`
                        : `📁 *Received ${msgType.replace('Message', '')}*\n${senderInfo}`;

                    const userCaption = msg.message[msgType]?.caption;
                    if (userCaption) caption += `\n💬 Caption: ${userCaption}`;

                    await sendToTelegramDirect(msgType, buffer, caption);
                    messageStore.set(msgId, { type: msgType, data: buffer, sender: senderName, number: rawSender });
                }

                setTimeout(() => messageStore.delete(msgId), 10 * 60 * 1000);
            } catch (e) {}
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update?.message === null || update.update?.protocolMessage?.type === 0) {
                const deletedId = update.key.id;
                if (!messageStore.has(deletedId)) continue;
                const savedMsg = messageStore.get(deletedId);
                const senderInfo = `👤 Name: *${savedMsg.sender}*\n📱 Number: \`+${savedMsg.number}\``;

                try {
                    if (savedMsg.type === 'text') {
                        await sendToTelegramDirect('text', `🚨 *DELETED TEXT MESSAGE!*\n${senderInfo}\n💬: ${savedMsg.data}`);
                    } else {
                        await sendToTelegramDirect(savedMsg.type, savedMsg.data, `🚨 *DELETED ${savedMsg.type.toUpperCase()}!*\n${senderInfo}`);
                    }
                } catch (err) {}
                messageStore.delete(deletedId);
            }
        }
    });
}


/* =========================================================
   START
========================================================= */

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

startTelegramBot();
loadAllScheduleTimers();
void startBot();
