require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const readline = require('readline');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const bot = new Telegraf(BOT_TOKEN);

const messageStore = new Map();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

function cleanText(text) {
    if (!text) return '';
    return String(text).replace(/[*_`[\]]/g, '');
}

async function sendToTelegramDirect(type, data, caption) {
    if (type === 'text') {
        await bot.telegram.sendMessage(CHAT_ID, data);
        return;
    }

    const ext = type === 'imageMessage' ? 'jpg' : (type === 'videoMessage' ? 'mp4' : 'bin');
    const tempFilePath = path.join(__dirname, `temp_${Date.now()}.${ext}`);

    try {
        await fs.promises.writeFile(tempFilePath, data);

        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append('caption', caption);

        let apiMethod = 'sendDocument';
        let fieldName = 'document';

        if (type === 'imageMessage') {
            apiMethod = 'sendPhoto';
            fieldName = 'photo';
        } else if (type === 'videoMessage') {
            apiMethod = 'sendVideo';
            fieldName = 'video';
        }

        form.append(fieldName, fs.createReadStream(tempFilePath));

        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/${apiMethod}`, form, {
            headers: form.getHeaders(),
            timeout: 120000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        console.log(`✅ Delivered ${type} to Telegram!`);
    } catch (err) {
        console.error("❌ Telegram Direct API Error:", err.response?.data?.description || err.message);
    } finally {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    let phoneNumber = '';
    if (!state.creds.registered) {
        phoneNumber = await question('📱 Enter your WhatsApp Phone Number with Country Code (e.g. 919876543210): ');
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    }

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '122.0.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    let codeRequested = false;
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Secure Pairing Code Trigger
        if (!sock.authState.creds.registered && !codeRequested && phoneNumber) {
            codeRequested = true;
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n====================================`);
                    console.log(`🔑 YOUR WHATSAPP PAIRING CODE IS: ${code}`);
                    console.log(`====================================\n`);
                } catch (err) {
                    console.error("Pairing Code Error:", err.message);
                }
            }, 6000); // 6 sec delay for full WS connection
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Online & Active!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const msgId = msg.key.id;
        const sender = cleanText(msg.pushName || msg.key.remoteJid);
        const msgType = Object.keys(msg.message)[0];

        try {
            if (msgType === 'conversation' || msgType === 'extendedTextMessage') {
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
                await sendToTelegramDirect('text', `📩 From: ${sender}\n💬: ${text}`);
                messageStore.set(msgId, { type: 'text', data: text, sender });
            } 
            else if (['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage'].includes(msgType)) {
                console.log(`🚀 Processing ${msgType} from ${sender}...`);
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                
                const caption = `📁 Received ${msgType.replace('Message', '')}\n👤 From: ${sender}`;
                await sendToTelegramDirect(msgType, buffer, caption);

                messageStore.set(msgId, { type: msgType, data: buffer, sender });
            }

            setTimeout(() => messageStore.delete(msgId), 10 * 60 * 1000);
        } catch (e) {
            console.error("Processing error:", e.message);
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update?.message === null || update.update?.protocolMessage?.type === 0) {
                const deletedId = update.key.id;
                if (messageStore.has(deletedId)) {
                    const savedMsg = messageStore.get(deletedId);
                    if (savedMsg.type === 'text') {
                        await sendToTelegramDirect('text', `🚨 DELETED TEXT CATCHED!\n👤 From: ${savedMsg.sender}\n💬: ${savedMsg.data}`);
                    } else {
                        await sendToTelegramDirect(savedMsg.type, savedMsg.data, `🚨 DELETED ${savedMsg.type.replace('Message','').toUpperCase()} CATCHED!\n👤 From: ${savedMsg.sender}`);
                    }
                    messageStore.delete(deletedId);
                }
            }
        }
    });
}

process.on('uncaughtException', (err) => console.error('Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('Rejection:', reason));

startBot();
