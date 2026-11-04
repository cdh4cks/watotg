/* =========================================================
   🤖 WHATSAPP TO TELEGRAM
   Creator / Credit: @Cdh4cks
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
    console.error(
        '❌ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in .env'
    );
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const messageStore = new Map();

const SCHEDULE_FILE =
    path.join(__dirname, 'schedules.json');

const AUTH_DIR =
    path.join(__dirname, 'auth_info_baileys');

const PAIRING_FILE =
    path.join(__dirname, '.pairing_phone');

let activeSock = null;
let botStarted = false;
let whatsappStarting = false;
let pairingPhoneNumber = '';

const scheduleTimers = new Map();
const scheduleRetryTimers = new Map();

const rl =
    readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

const question = (text) =>
    new Promise((resolve) =>
        rl.question(text, resolve)
    );


/* =========================================================
   BASIC HELPERS
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
   PAIRING PHONE STORAGE
========================================================= */

function loadPairingPhone() {
    try {
        if (fs.existsSync(PAIRING_FILE)) {
            return normalizeNumber(
                fs.readFileSync(PAIRING_FILE, 'utf8')
            );
        }
    } catch (err) {
        console.error('Pairing phone read error:', err.message);
    }
    return '';
}

function savePairingPhone(number) {
    try {
        fs.writeFileSync(PAIRING_FILE, normalizeNumber(number), 'utf8');
    } catch (err) {
        console.error('Pairing phone save error:', err.message);
    }
}

function clearPairingPhone() {
    pairingPhoneNumber = '';
    try {
        if (fs.existsSync(PAIRING_FILE)) {
            fs.unlinkSync(PAIRING_FILE);
        }
    } catch (err) {
        console.error('Pairing phone delete error:', err.message);
    }
}


/* =========================================================
   SCHEDULE STORAGE
========================================================= */

function loadSchedules() {
    try {
        if (!fs.existsSync(SCHEDULE_FILE)) {
            return [];
        }
        const data = JSON.parse(
            fs.readFileSync(SCHEDULE_FILE, 'utf8')
        );
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Schedule file read error:', err.message);
        return [];
    }
}

function saveSchedules(schedules) {
    fs.writeFileSync(
        SCHEDULE_FILE,
        JSON.stringify(schedules, null, 2)
    );
}


/* =========================================================
   TELEGRAM DIRECT SENDER
========================================================= */

async function sendToTelegramDirect(type, data, caption) {
    if (type === 'text') {
        await bot.telegram.sendMessage(CHAT_ID, data);
        return;
    }

    const ext =
        type === 'imageMessage' ? 'jpg' :
        type === 'videoMessage' ? 'mp4' :
        type === 'audioMessage' ? 'ogg' : 'bin';

    const tempFilePath = path.join(
        __dirname,
        `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    );

    try {
        await fs.promises.writeFile(tempFilePath, data);
        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        if (caption) {
            form.append('caption', caption);
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

        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/${apiMethod}`,
            form,
            {
                headers: form.getHeaders(),
                timeout: 120000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        console.log(`✅ Delivered ${type} to Telegram!`);
    } catch (err) {
        console.error('❌ Telegram Direct API Error:', err.response?.data?.description || err.message);
    } finally {
        try {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        } catch (_) {}
    }
}


/* =========================================================
   SCHEDULE TIMER
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
    if (!Number.isFinite(target)) {
        console.log(`❌ Invalid schedule date: ${item.id}`);
        return;
    }

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


/* =========================================================
   SEND SCHEDULED MESSAGE (WITH MEDIA SUPPORT)
========================================================= */

async function sendScheduledMessage(id) {
    clearScheduleTimer(id);
    const schedules = loadSchedules();
    const item = schedules.find(x => x.id === id);

    if (!item || item.status !== 'pending') return;

    if (!activeSock) {
        console.log(`⏳ WhatsApp offline. Schedule ${id} waiting...`);
        retrySchedule(id, 10000);
        return;
    }

    try {
        const number = normalizeNumber(item.number);
        if (!isValidPhoneNumber(number)) {
            throw new Error('Invalid WhatsApp number');
        }

        item.status = 'sending';
        item.lastAttemptAt = new Date().toISOString();
        saveSchedules(schedules);

        const jid = jidFromNumber(number);

        // Check if message has media saved
        if (item.mediaPath && fs.existsSync(item.mediaPath)) {
            const mediaBuffer = fs.readFileSync(item.mediaPath);
            if (item.mediaType === 'image') {
                await activeSock.sendMessage(jid, {
                    image: mediaBuffer,
                    caption: item.message || ''
                });
            } else if (item.mediaType === 'video') {
                await activeSock.sendMessage(jid, {
                    video: mediaBuffer,
                    caption: item.message || ''
                });
            } else if (item.mediaType === 'document') {
                await activeSock.sendMessage(jid, {
                    document: mediaBuffer,
                    mimetype: 'application/octet-stream',
                    fileName: 'scheduled_file',
                    caption: item.message || ''
                });
            }
        } else {
            // Text only message
            await activeSock.sendMessage(jid, { text: item.message });
        }

        item.status = 'sent';
        item.sentAt = new Date().toISOString();
        delete item.lastError;
        saveSchedules(schedules);

        console.log(`✅ SCHEDULED MESSAGE SENT: ${number} (By   Bot)`);

        try {
            await bot.telegram.sendMessage(
                CHAT_ID,
                [
                    '✨ **  Bot: Scheduled Message Sent** ✨',
                    '',
                    `📱 To: ${item.number}`,
                    `📅 Date: ${item.date}`,
                    `⏰ Time: ${item.time}`,
                    `💬 Message: ${item.message || '(Media Only)'}`,
                    `🆔 ID: ${item.id}`
                ].join('\n')
            );
        } catch (telegramError) {
            console.error('Telegram notification error:', telegramError.message);
        }
    } catch (error) {
        console.error(`❌ Scheduled send failed (${id}):`, error.message);
        const currentSchedules = loadSchedules();
        const current = currentSchedules.find(x => x.id === id);
        if (current) {
            current.status = 'pending';
            current.lastError = error.message;
            current.lastAttemptAt = new Date().toISOString();
            saveSchedules(currentSchedules);
        }
        retrySchedule(id, 10000);
    }
}


/* =========================================================
   LOAD ALL SCHEDULES
========================================================= */

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

    if (changed) {
        saveSchedules(schedules);
    }

    console.log(`📅 Loaded ${schedules.filter(x => x.status === 'pending').length} pending schedule(s).`);
}


/* =========================================================
   TELEGRAM ACCESS
========================================================= */

function isAllowedChat(ctx) {
    return String(ctx.chat?.id) === String(CHAT_ID);
}


/* =========================================================
   SCHEDULE WIZARD (WITH MEDIA SUPPORT)
========================================================= */

const scheduleSessions = new Map();

function startSchedule(ctx) {
    scheduleSessions.set(String(ctx.chat.id), {
        step: 'number',
        data: {}
    });

    return ctx.reply(
        '✨ **  WhatsApp Scheduler** ✨\n\n' +
        '📱 Enter WhatsApp number with country code:\n' +
        'Example: `919876543210`',
        { parse_mode: 'Markdown' }
    );
}

function isRealDate(dateString) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const d = new Date(year, month - 1, day);
    return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

async function handleScheduleInput(ctx) {
    const chatId = String(ctx.chat.id);
    const session = scheduleSessions.get(chatId);
    if (!session) return false;

    const input = String(ctx.message?.text || '').trim();
    const hasPhoto = ctx.message?.photo;
    const hasDocument = ctx.message?.document;
    const hasVideo = ctx.message?.video;

    /* NUMBER */
    if (session.step === 'number') {
        const number = normalizeNumber(input);
        if (!isValidPhoneNumber(number)) {
            await ctx.reply('❌ Invalid number.\n\nExample: `919876543210`', { parse_mode: 'Markdown' });
            return true;
        }
        session.data.number = number;
        session.step = 'date';
        await ctx.reply('📅 Enter date:\nFormat: `YYYY-MM-DD`\nExample: `2026-09-25`', { parse_mode: 'Markdown' });
        return true;
    }

    /* DATE */
    if (session.step === 'date') {
        if (!isRealDate(input)) {
            await ctx.reply('❌ Invalid date format.\nUse: `YYYY-MM-DD`', { parse_mode: 'Markdown' });
            return true;
        }
        session.data.date = input;
        session.step = 'time';
        await ctx.reply('⏰ Enter time (24-Hour):\nFormat: `HH:MM`\nExample: `22:30`', { parse_mode: 'Markdown' });
        return true;
    }

    /* TIME */
    if (session.step === 'time') {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input)) {
            await ctx.reply('❌ Invalid time.\nUse 24-hour format: `HH:MM`', { parse_mode: 'Markdown' });
            return true;
        }
        session.data.time = input;
        session.step = 'message';
        await ctx.reply(
            '💬 **Enter message or send media (Photo/Video/Document)!**\n' +
            'Aap text likh sakte hain ya koi photo/video bhej sakte hain (with optional caption).',
            { parse_mode: 'Markdown' }
        );
        return true;
    }

    /* MESSAGE / MEDIA */
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
            await ctx.reply('❌ Ye date/time already past hai. Future date enter karo.');
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
                '✅ **SUCCESSFULLY SCHEDULED** ( )',
                '',
                `🆔 ID: \`${item.id}\``,
                `📱 To: \`${item.number}\``,
                `📅 Date: ${item.date}`,
                `⏰ Time: ${item.time}`,
                `💬 Text: ${item.message || '(Media File Attached)'}`,
                '',
                'Status: PENDING ⏳'
            ].join('\n'),
            { parse_mode: 'Markdown' }
        );

        return true;
    }
    return true;
}


/* =========================================================
   TELEGRAM COMMANDS & UI (WITH BUTTONS &  )
========================================================= */

bot.start(async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.reply(
        '🤖 **Welcome to WhatsApp Automation Bot**\n' +
        'By: ** ** 🚀\n\n' +
        'Use the menu below to control your schedules:',
        Markup.inlineKeyboard([
            [Markup.button.callback('📅 Schedule Message', 'btn_schedule'), Markup.button.callback('📋 List Schedules', 'btn_list')],
            [Markup.button.callback('📊 Bot Status', 'btn_status'), Markup.button.callback('💾 Backup Data', 'btn_backup')],
            [Markup.button.callback('❌ Cancel Wizard', 'btn_cancel')]
        ])
    );
});

bot.action('btn_schedule', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();
    await startSchedule(ctx);
});

bot.action('btn_list', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();
    
    const schedules = loadSchedules();
    if (!schedules.length) {
        return ctx.reply('📭 No scheduled messages found.');
    }

    const keyboardButtons = [];
    const lines = ['✨ **SCHEDULED MESSAGES ( )** ✨\n'];

    for (const item of schedules) {
        lines.push(`🆔 ID: \`${item.id}\`\n📱 ${item.number} | 📅 ${item.date} ${item.time}\n💬 ${item.message || '(Media)'}\n📌 Status: **${item.status}**\n---`);
        if (item.status === 'pending') {
            keyboardButtons.push([Markup.button.callback(`❌ Delete ${item.id}`, `del_${item.id}`)]);
        }
    }

    await ctx.reply(lines.join('\n'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboardButtons)
    });
});

bot.action(/^del_(.+)$/, async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];

    const schedules = loadSchedules();
    const index = schedules.findIndex(x => x.id === id);
    if (index === -1) {
        return ctx.reply('❌ Schedule ID not found.');
    }

    clearScheduleTimer(id);
    schedules.splice(index, 1);
    saveSchedules(schedules);

    await ctx.reply(`✅ Successfully deleted schedule ID: \`${id}\``, { parse_mode: 'Markdown' });
});

bot.action('btn_status', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();

    const schedules = loadSchedules();
    const pending = schedules.filter(x => x.status === 'pending').length;
    const sent = schedules.filter(x => x.status === 'sent').length;

    await ctx.reply(
        [
            '🤖 **  WISHFLOW STATUS** 🤖',
            '',
            `WhatsApp: ${activeSock ? '🟢 Connected' : '🔴 Disconnected'}`,
            `Pending Schedules: ${pending}`,
            `Sent Messages: ${sent}`,
            `Credit:  `
        ].join('\n'),
        { parse_mode: 'Markdown' }
    );
});

bot.action('btn_backup', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();

    if (fs.existsSync(SCHEDULE_FILE)) {
        await ctx.replyWithDocument({ source: SCHEDULE_FILE }, { caption: '💾 **Schedules Backup File** ( )' });
    } else {
        await ctx.reply('📭 No schedule file found to backup.');
    }
});

bot.action('btn_cancel', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await ctx.answerCbQuery();
    scheduleSessions.delete(String(ctx.chat.id));
    await ctx.reply('❌ Current wizard cancelled.');
});


/* COMMANDS FOR TEXT */

bot.command('schedule', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await startSchedule(ctx);
});

bot.command('list', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    // Triggers same list logic via callback query or message
    const schedules = loadSchedules();
    if (!schedules.length) return ctx.reply('📭 No scheduled messages.');
    
    let text = '📅 **SCHEDULED MESSAGES ( )**\n\n';
    schedules.forEach(i => {
        text += `🆔 \`${i.id}\`\n📱 ${i.number} | 📅 ${i.date} ${i.time}\n💬 ${i.message || '(Media)'}\n📌 ${i.status}\n\n`;
    });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('backup', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    if (fs.existsSync(SCHEDULE_FILE)) {
        await ctx.replyWithDocument({ source: SCHEDULE_FILE }, { caption: '💾 **Backup File ( )**' });
    } else {
        await ctx.reply('📭 No data found.');
    }
});

bot.command('status', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    const schedules = loadSchedules();
    await ctx.reply(`🤖 Bot Online | Pending: ${schedules.filter(x => x.status === 'pending').length} | By  `);
});


/* =========================================================
   TELEGRAM TEXT HANDLER
========================================================= */

bot.on('text', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    const text = String(ctx.message?.text || '').trim();
    if (text.startsWith('/')) return;
    await handleScheduleInput(ctx);
});

bot.on('photo', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await handleScheduleInput(ctx);
});

bot.on('document', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await handleScheduleInput(ctx);
});


/* =========================================================
   START TELEGRAM BOT
========================================================= */

function startTelegramBot() {
    if (botStarted) return;
    botStarted = true;

    bot.launch()
        .then(() => {
            console.log('🤖 Telegram bot controls online! (Credit:  )');
        })
        .catch((err) => {
            console.log('Telegram bot error:', err.message);
            botStarted = false;
        });

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}


/* =========================================================
   WHATSAPP SOCKET & FORWARDERS (UNCHANGED CORE)
========================================================= */

async function startBot() {
    if (whatsappStarting) return;
    whatsappStarting = true;

    let state, saveCreds;
    try {
        ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
    } catch (err) {
        whatsappStarting = false;
        console.error('❌ Auth state error:', err.message);
        setTimeout(() => void startBot(), 5000);
        return;
    }

    let phoneNumber = '';
    if (state.creds.registered) {
        clearPairingPhone();
        console.log('🔐 Saved WhatsApp session found. (By  )');
    } else {
        pairingPhoneNumber = pairingPhoneNumber || loadPairingPhone();
        if (!pairingPhoneNumber) {
            pairingPhoneNumber = normalizeNumber(
                await question('📱 Enter WhatsApp Phone Number with Country Code (e.g. 919876543210): ')
            );
            if (!isValidPhoneNumber(pairingPhoneNumber)) {
                console.log('❌ Invalid phone number.');
                whatsappStarting = false;
                return;
            }
            savePairingPhone(pairingPhoneNumber);
        }
        phoneNumber = pairingPhoneNumber;
    }

    let sock;
    try {
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '122.0.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: true
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
                    console.log('\n====================================');
                    console.log(`🔑   PAIRING CODE: ${code}`);
                    console.log('====================================\n');
                } catch (err) {
                    codeRequested = false;
                }
            }, 6000);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (activeSock === sock) activeSock = null;

            if (statusCode === DisconnectReason.loggedOut) {
                clearPairingPhone();
                return;
            }
            setTimeout(() => {
                if (!activeSock && !whatsappStarting) void startBot();
            }, 3000);
        } else if (connection === 'open') {
            activeSock = sock;
            clearPairingPhone();
            console.log('✅ WhatsApp Online & Active! ( )');
            loadAllScheduleTimers();
        }
    });

    /* Incoming messages & status forwarder */
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' && m.type !== 'append') return;

        for (const msg of m.messages || []) {
            if (!msg.message) continue;
            const remoteJid = msg.key.remoteJid;
            const isStatus = remoteJid === 'status@broadcast';

            if (!isStatus && msg.key.fromMe) continue;

            const msgId = msg.key.id;
            let sender = isStatus ? (msg.pushName || msg.key.participant || 'Status') : cleanText(msg.pushName || remoteJid);
            const msgType = Object.keys(msg.message)[0];

            try {
                if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
                    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    const formattedText = isStatus
                        ? `📸 ** : TEXT STATUS**\n👤 From: ${sender}\n💬: ${text}`
                        : `📩 From: ${sender}\n💬: ${text}`;

                    await sendToTelegramDirect('text', formattedText);
                    messageStore.set(msgId, { type: 'text', data: text, sender });
                } else if (['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage'].includes(msgType)) {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                    let caption = isStatus
                        ? `📸 ** : MEDIA STATUS**\n👤 From: ${sender}`
                        : `📁 Received ${msgType.replace('Message', '')}\n👤 From: ${sender}`;

                    const userCaption = msg.message[msgType]?.caption;
                    if (userCaption) caption += `\n💬 Caption: ${userCaption}`;

                    await sendToTelegramDirect(msgType, buffer, caption);
                    messageStore.set(msgId, { type: msgType, data: buffer, sender });
                }

                setTimeout(() => messageStore.delete(msgId), 10 * 60 * 1000);
            } catch (e) {}
        }
    });

    /* Deleted message catcher */
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update?.message === null || update.update?.protocolMessage?.type === 0) {
                const deletedId = update.key.id;
                if (!messageStore.has(deletedId)) continue;
                const savedMsg = messageStore.get(deletedId);

                try {
                    if (savedMsg.type === 'text') {
                        await sendToTelegramDirect('text', `🚨 ** : DELETED TEXT!**\n👤 From: ${savedMsg.sender}\n💬: ${savedMsg.data}`);
                    } else {
                        await sendToTelegramDirect(savedMsg.type, savedMsg.data, `🚨 ** : DELETED ${savedMsg.type.toUpperCase()}!**\n👤 From: ${savedMsg.sender}`);
                    }
                } catch (err) {}
                messageStore.delete(deletedId);
            }
        }
    });
}


/* =========================================================
   ERRORS & START
========================================================= */

process.on('uncaughtException', (err) => {});
process.on('unhandledRejection', (reason) => {});

startTelegramBot();
loadAllScheduleTimers();
void startBot();
