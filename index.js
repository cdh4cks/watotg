require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const { Telegraf } = require('telegraf');

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
const contactsMap = new Map();

const SCHEDULE_FILE = path.join(__dirname, 'schedules.json');
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const PAIRING_FILE = path.join(__dirname, '.pairing_phone');

let activeSock = null;
let botStarted = false;
let whatsappStarting = false;
let pairingPhoneNumber = '';
let isFirstConnectNotificationSent = false;

const scheduleTimers = new Map();
const scheduleRetryTimers = new Map();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (text) =>
    new Promise((resolve) =>
        rl.question(text, resolve)
    );


/* =========================================================
   BASIC HELPERS & CONTACT RESOLVER
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

function getContactDisplayName(jid) {
    if (!jid) return 'Unknown';
    if (jid === 'status@broadcast') return 'Status Broadcast';
    
    const cleanJid = jid.includes('@') ? jid : jidFromNumber(jid);
    
    if (contactsMap.has(cleanJid)) {
        const name = contactsMap.get(cleanJid);
        if (name) return cleanText(name);
    }
    
    const num = cleanJid.split('@')[0];
    return num ? `+${num}` : cleanJid;
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
    } catch (err) {}
    return '';
}

function savePairingPhone(number) {
    try {
        fs.writeFileSync(
            PAIRING_FILE,
            normalizeNumber(number),
            'utf8'
        );
    } catch (err) {}
}

function clearPairingPhone() {
    pairingPhoneNumber = '';
    try {
        if (fs.existsSync(PAIRING_FILE)) {
            fs.unlinkSync(PAIRING_FILE);
        }
    } catch (err) {}
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
        return [];
    }
}

function saveSchedules(schedules) {
    try {
        fs.writeFileSync(
            SCHEDULE_FILE,
            JSON.stringify(schedules, null, 2)
        );
    } catch (err) {}
}


/* =========================================================
   TELEGRAM DIRECT SENDER (STABLE & NON-BLOCKING)
========================================================= */

async function sendToTelegramDirect(
    type,
    data,
    caption
) {
    if (type === 'text') {
        bot.telegram.sendMessage(CHAT_ID, data, { parse_mode: 'Markdown' }).catch(() => {});
        return;
    }

    let ext = 'bin';
    if (type === 'imageMessage') ext = 'jpg';
    else if (type === 'videoMessage') ext = 'mp4';
    else if (type === 'audioMessage' || type === 'pttMessage') ext = 'ogg';
    else if (type === 'documentMessage') ext = 'bin';

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
        } else if (type === 'audioMessage' || type === 'pttMessage') {
            apiMethod = 'sendAudio';
            fieldName = 'audio';
        }

        form.append(
            fieldName,
            fs.createReadStream(tempFilePath)
        );

        axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/${apiMethod}`,
            form,
            {
                headers: form.getHeaders(),
                timeout: 180000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        ).catch(() => {});

    } catch (err) {
    } finally {
        setTimeout(() => {
            try {
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
            } catch (_) {}
        }, 10000);
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


/* =========================================================
   SEND SCHEDULED MESSAGE
========================================================= */

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
        if (!isValidPhoneNumber(number)) {
            throw new Error('Invalid WhatsApp number');
        }

        item.status = 'sending';
        item.lastAttemptAt = new Date().toISOString();
        saveSchedules(schedules);

        await activeSock.sendMessage(jidFromNumber(number), {
            text: item.message
        });

        item.status = 'sent';
        item.sentAt = new Date().toISOString();
        delete item.lastError;
        saveSchedules(schedules);

        const displayName = getContactDisplayName(jidFromNumber(number));

        await bot.telegram.sendMessage(
            CHAT_ID,
            [
                '✅ *Scheduled WhatsApp Message Sent*',
                '',
                `📱 *To:* ${displayName} (\`${item.number}\`)`,
                `📅 *Date:* ${item.date}`,
                `⏰ *Time:* ${item.time}`,
                `💬 *Message:* ${item.message}`,
                `🆔 *ID:* \`${item.id}\``
            ].join('\n'),
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    } catch (error) {
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

async function loadAllScheduleTimers() {
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
    const pendingCount = schedules.filter(x => x.status === 'pending').length;
    console.log(`📅 Loaded ${pendingCount} pending schedule(s).`);

    if (!isFirstConnectNotificationSent && activeSock) {
        isFirstConnectNotificationSent = true;
        if (pendingCount > 0) {
            const lines = ['🚀 *Bot Connected! Active Schedules:*', ''];
            for (const item of schedules.filter(x => x.status === 'pending')) {
                const displayName = getContactDisplayName(jidFromNumber(item.number));
                lines.push(
                    `🆔 \`${item.id}\``,
                    `📱 ${displayName} (\`${item.number}\`)`,
                    `📅 ${item.date} ⏰ ${item.time}`,
                    `💬 ${item.message}`,
                    '------------------'
                );
            }
            try {
                await bot.telegram.sendMessage(CHAT_ID, lines.join('\n'), { parse_mode: 'Markdown' });
            } catch (err) {}
        }
    }
}


/* =========================================================
   TELEGRAM ACCESS & WIZARD
========================================================= */

function isAllowedChat(ctx) {
    return String(ctx.chat?.id) === String(CHAT_ID);
}

const scheduleSessions = new Map();

function startSchedule(ctx) {
    scheduleSessions.set(String(ctx.chat.id), {
        step: 'number',
        data: {}
    });
    return ctx.reply(
        '📅 *Schedule WhatsApp Message*\n\n📱 Enter WhatsApp number with country code:\nExample: `919876543210`',
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
    if (!input) return true;

    if (session.step === 'number') {
        const number = normalizeNumber(input);
        if (!isValidPhoneNumber(number)) {
            await ctx.reply('❌ Invalid number.\n\nExample: `919876543210`', { parse_mode: 'Markdown' });
            return true;
        }
        session.data.number = number;
        session.step = 'date';
        await ctx.reply('📅 Enter date:\nFormat: `YYYY-MM-DD`\n\nExample: `2026-09-25`', { parse_mode: 'Markdown' });
        return true;
    }

    if (session.step === 'date') {
        if (!isRealDate(input)) {
            await ctx.reply('❌ Invalid date. Use: `YYYY-MM-DD`', { parse_mode: 'Markdown' });
            return true;
        }
        session.data.date = input;
        session.step = 'time';
        await ctx.reply('⏰ Enter time:\nFormat: `HH:MM` (24-hour)\n\nExample: `22:30`', { parse_mode: 'Markdown' });
        return true;
    }

    if (session.step === 'time') {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input)) {
            await ctx.reply('❌ Invalid time. Use 24-hour format: `22:30`', { parse_mode: 'Markdown' });
            return true;
        }
        session.data.time = input;
        session.step = 'message';
        await ctx.reply('💬 Enter the WhatsApp message:');
        return true;
    }

    if (session.step === 'message') {
        session.data.message = input;
        const datetime = `${session.data.date}T${session.data.time}:00`;
        const target = new Date(datetime).getTime();

        if (!Number.isFinite(target) || target <= Date.now()) {
            await ctx.reply('❌ Yeh date/time pehle ki hai. Future date/time enter karein.');
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
            status: 'pending',
            createdAt: new Date().toISOString()
        };

        schedules.push(item);
        saveSchedules(schedules);
        scheduleTimer(item);
        scheduleSessions.delete(chatId);

        const displayName = getContactDisplayName(jidFromNumber(item.number));

        await ctx.reply(
            [
                '✅ *SCHEDULED SUCCESSFULLY*',
                '',
                `🆔 *ID:* \`${item.id}\``,
                `📱 *To:* ${displayName} (\`${item.number}\`)`,
                `📅 *Date:* ${item.date}`,
                `⏰ *Time:* ${item.time}`,
                `💬 *Message:* ${item.message}`,
                '',
                'Status: PENDING'
            ].join('\n'),
            { parse_mode: 'Markdown' }
        );
        return true;
    }
    return true;
}


/* =========================================================
   TELEGRAM COMMANDS
========================================================= */

bot.command('schedule', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    await startSchedule(ctx);
});

bot.command('list', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    const schedules = loadSchedules();
    if (!schedules.length) {
        await ctx.reply('📭 No scheduled messages.');
        return;
    }

    const lines = ['📅 *SCHEDULED MESSAGES*', ''];
    for (const item of schedules) {
        const displayName = getContactDisplayName(jidFromNumber(item.number));
        lines.push(
            `🆔 \`${item.id}\``,
            `📱 ${displayName} (\`${item.number}\`)`,
            `📅 ${item.date} ⏰ ${item.time}`,
            `💬 ${item.message}`,
            `📌 Status: *${item.status}*`,
            item.lastError ? `⚠️ ${item.lastError}` : '',
            '------------------'
        );
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

bot.command('delete', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    const parts = String(ctx.message.text).trim().split(/\s+/);
    const id = parts[1];

    if (!id) {
        await ctx.reply('Usage:\n`/delete ID`', { parse_mode: 'Markdown' });
        return;
    }

    const schedules = loadSchedules();
    const index = schedules.findIndex(x => x.id === id);

    if (index === -1) {
        await ctx.reply('❌ Schedule ID not found.');
        return;
    }

    if (schedules[index].status === 'sent') {
        await ctx.reply('❌ Yeh message already sent ho chuka hai.');
        return;
    }

    clearScheduleTimer(id);
    schedules.splice(index, 1);
    saveSchedules(schedules);
    await ctx.reply(`✅ Deleted schedule:\n\`${id}\``, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    const schedules = loadSchedules();
    const pending = schedules.filter(x => x.status === 'pending').length;
    const sending = schedules.filter(x => x.status === 'sending').length;
    const sent = schedules.filter(x => x.status === 'sent').length;

    await ctx.reply(
        [
            '🤖 *WISHFLOW STATUS*',
            '',
            `WhatsApp: ${activeSock ? '🟢 Connected' : '🔴 Disconnected'}`,
            `Pending: ${pending}`,
            `Sending: ${sending}`,
            `Sent: ${sent}`,
            `Pairing: ${activeSock ? 'Not needed' : pairingPhoneNumber ? 'Waiting / Saved' : 'Not registered'}`
        ].join('\n'),
        { parse_mode: 'Markdown' }
    );
});

bot.command('cancel', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    scheduleSessions.delete(String(ctx.chat.id));
    await ctx.reply('❌ Current scheduling cancelled.');
});

bot.on('text', async (ctx) => {
    if (!isAllowedChat(ctx)) return;
    const text = String(ctx.message?.text || '').trim();
    if (text.startsWith('/')) return;
    await handleScheduleInput(ctx);
});

function startTelegramBot() {
    if (botStarted) return;
    botStarted = true;
    bot.launch()
        .then(() => console.log('🤖 Telegram bot controls online!'))
        .catch((err) => {
            botStarted = false;
        });

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}


/* =========================================================
   WHATSAPP CORE (ULTRA-STABLE TIMEOUT & QUERY FIX)
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

    if (state.creds.registered) {
        clearPairingPhone();
        console.log('🔐 Saved WhatsApp session found. Pairing is NOT required.');
    } else {
        pairingPhoneNumber = pairingPhoneNumber || loadPairingPhone();

        if (!pairingPhoneNumber) {
            pairingPhoneNumber = normalizeNumber(
                await question('📱 Enter your WhatsApp Phone Number with Country Code (e.g. 919876543210): ')
            );

            if (!isValidPhoneNumber(pairingPhoneNumber)) {
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
            markOnlineOnConnect: false,         // Disable unnecessary online status queries on init
            generateHighQualityLinkPreview: false,
            connectTimeoutMs: 120000,           // 120 seconds connection timeout
            defaultQueryTimeoutMs: 120000,      // 120 seconds query timeout (Fixes 408 init queries error)
            keepAliveIntervalMs: 25000,         // Ping interval to keep connection alive
            retryRequestDelayMs: 3000
        });
    } catch (err) {
        whatsappStarting = false;
        setTimeout(() => void startBot(), 5000);
        return;
    }

    activeSock = sock;
    whatsappStarting = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) {
            if (contact.id && (contact.name || contact.notify)) {
                contactsMap.set(contact.id, contact.name || contact.notify);
            }
        }
    });

    sock.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
            if (update.id && (update.name || update.notify)) {
                contactsMap.set(update.id, update.name || update.notify);
            }
        }
    });

    let codeRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (!state.creds.registered && !codeRequested && phoneNumber) {
            codeRequested = true;
            setTimeout(async () => {
                try {
                    if (state.creds.registered) return;
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n🔑 YOUR WHATSAPP PAIRING CODE IS: ${code}\n`);
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

            console.log(`🔄 WhatsApp disconnected. Reconnecting in 3s...`);
            setTimeout(() => {
                if (!activeSock && !whatsappStarting) {
                    void startBot();
                }
            }, 3000);
        } else if (connection === 'open') {
            activeSock = sock;
            clearPairingPhone();
            console.log('✅ WhatsApp Online & Active securely!');
            await loadAllScheduleTimers();
        }
    });


    /* =====================================================
       LIGHTNING-FAST INCOMING MESSAGES, MEDIA, & STATUS
    ===================================================== */

    sock.ev.on('messages.upsert', (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages || []) {
            if (!msg.message) continue;

            const msgId = msg.key.id;
            const remoteJid = msg.key.remoteJid;
            
            // Handle WhatsApp Status Stories instantly
            if (remoteJid === 'status@broadcast') {
                (async () => {
                    const participantJid = msg.key.participant || '';
                    const senderName = getContactDisplayName(participantJid);
                    const msgType = Object.keys(msg.message)[0];

                    try {
                        if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
                            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                            await sendToTelegramDirect('text', `📸 *WhatsApp Status Update*\n👤 *From:* ${senderName}\n💬: ${text}`);
                        } else if (['imageMessage', 'videoMessage'].includes(msgType)) {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                            await sendToTelegramDirect(msgType, buffer, `📸 *WhatsApp Status Media*\n👤 *From:* ${senderName}`);
                        }
                    } catch (err) {}
                })();
                continue;
            }

            if (msg.key.fromMe) continue;

            const senderName = getContactDisplayName(remoteJid);
            const msgType = Object.keys(msg.message)[0];

            if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                messageStore.set(msgId, { type: 'text', data: text, sender: senderName });
                sendToTelegramDirect('text', `📩 *From:* ${senderName}\n💬: ${text}`);
            } else if (['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'pttMessage'].includes(msgType)) {
                (async () => {
                    try {
                        const buffer = await downloadMediaMessage(
                            msg,
                            'buffer',
                            {},
                            { reuploadRequest: sock.updateMediaMessage }
                        );

                        let docName = '';
                        if (msgType === 'documentMessage') {
                            docName = msg.message.documentMessage?.fileName || 'file.bin';
                        }

                        const cleanTypeName = msgType.replace('Message', '').toUpperCase();
                        const caption = `📁 Received High-Quality *${cleanTypeName}*${docName ? ` (${docName})` : ''}\n👤 *From:* ${senderName}`;

                        messageStore.set(msgId, {
                            type: msgType,
                            data: buffer,
                            sender: senderName
                        });

                        await sendToTelegramDirect(msgType, buffer, caption);
                    } catch (e) {}
                })();
            }

            setTimeout(() => messageStore.delete(msgId), 10 * 60 * 1000);
        }
    });


    /* =====================================================
       INSTANT DELETED MESSAGE CATCHER
    ===================================================== */

    sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
            if (
                update.update?.message === null ||
                update.update?.protocolMessage?.type === 0
            ) {
                const deletedId = update.key.id;
                if (!messageStore.has(deletedId)) continue;

                const savedMsg = messageStore.get(deletedId);
                messageStore.delete(deletedId);

                (async () => {
                    try {
                        if (savedMsg.type === 'text') {
                            await sendToTelegramDirect(
                                'text',
                                `🚨 *DELETED TEXT CATCHED!*\n👤 *From:* ${savedMsg.sender}\n💬: ${savedMsg.data}`
                            );
                        } else {
                            await sendToTelegramDirect(
                                savedMsg.type,
                                savedMsg.data,
                                `🚨 *DELETED ${savedMsg.type.replace('Message', '').toUpperCase()} CATCHED!*\n👤 *From:* ${savedMsg.sender}`
                            );
                        }
                    } catch (err) {}
                })();
            }
        }
    });
}


/* =========================================================
   CONNECTION HEALTH MONITOR
========================================================= */

setInterval(() => {
    if (!activeSock) {
        if (!whatsappStarting) {
            void startBot();
        }
    }
}, 5 * 60 * 1000);


/* =========================================================
   ERROR HANDLERS
========================================================= */

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});


/* =========================================================
   START APPLICATION
========================================================= */

startTelegramBot();
loadAllScheduleTimers();
void startBot();
