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

const scheduleRetryTimers =
    new Map();

const rl =
    readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

const question = (text) =>
    new Promise((resolve) =>
        rl.question(
            text,
            resolve
        )
    );


/* =========================================================
   BASIC HELPERS
========================================================= */

function cleanText(text) {
    if (!text) return '';

    return String(text)
        .replace(/[*_`[\]]/g, '');
}


function normalizeNumber(number) {
    return String(number || '')
        .replace(/\D/g, '');
}


function isValidPhoneNumber(number) {
    const value =
        normalizeNumber(number);

    return (
        value.length >= 8 &&
        value.length <= 15
    );
}


function jidFromNumber(number) {
    return `${normalizeNumber(number)}@s.whatsapp.net`;
}


/* =========================================================
   PAIRING PHONE STORAGE
========================================================= */

function loadPairingPhone() {
    try {
        if (
            fs.existsSync(
                PAIRING_FILE
            )
        ) {
            return normalizeNumber(
                fs.readFileSync(
                    PAIRING_FILE,
                    'utf8'
                )
            );
        }
    } catch (err) {
        console.error(
            'Pairing phone read error:',
            err.message
        );
    }

    return '';
}


function savePairingPhone(number) {
    try {
        fs.writeFileSync(
            PAIRING_FILE,
            normalizeNumber(number),
            'utf8'
        );
    } catch (err) {
        console.error(
            'Pairing phone save error:',
            err.message
        );
    }
}


function clearPairingPhone() {
    pairingPhoneNumber = '';

    try {
        if (
            fs.existsSync(
                PAIRING_FILE
            )
        ) {
            fs.unlinkSync(
                PAIRING_FILE
            );
        }
    } catch (err) {
        console.error(
            'Pairing phone delete error:',
            err.message
        );
    }
}


/* =========================================================
   SCHEDULE STORAGE
========================================================= */

function loadSchedules() {
    try {
        if (
            !fs.existsSync(
                SCHEDULE_FILE
            )
        ) {
            return [];
        }

        const data =
            JSON.parse(
                fs.readFileSync(
                    SCHEDULE_FILE,
                    'utf8'
                )
            );

        return Array.isArray(data)
            ? data
            : [];
    } catch (err) {
        console.error(
            'Schedule file read error:',
            err.message
        );

        return [];
    }
}


function saveSchedules(schedules) {
    fs.writeFileSync(
        SCHEDULE_FILE,
        JSON.stringify(
            schedules,
            null,
            2
        )
    );
}


/* =========================================================
   TELEGRAM DIRECT SENDER
========================================================= */

async function sendToTelegramDirect(
    type,
    data,
    caption
) {
    if (
        type === 'text'
    ) {
        await bot.telegram.sendMessage(
            CHAT_ID,
            data
        );

        return;
    }

    const ext =
        type === 'imageMessage'
            ? 'jpg'
            : type === 'videoMessage'
                ? 'mp4'
                : type === 'audioMessage'
                    ? 'ogg'
                    : 'bin';

    const tempFilePath =
        path.join(
            __dirname,
            `temp_${Date.now()}_${Math.random()
                .toString(36)
                .slice(2)}.${ext}`
        );

    try {
        await fs.promises.writeFile(
            tempFilePath,
            data
        );

        const form =
            new FormData();

        form.append(
            'chat_id',
            CHAT_ID
        );

        if (caption) {
            form.append(
                'caption',
                caption
            );
        }

        let apiMethod =
            'sendDocument';

        let fieldName =
            'document';

        if (
            type ===
            'imageMessage'
        ) {
            apiMethod =
                'sendPhoto';

            fieldName =
                'photo';
        } else if (
            type ===
            'videoMessage'
        ) {
            apiMethod =
                'sendVideo';

            fieldName =
                'video';
        } else if (
            type ===
            'audioMessage'
        ) {
            apiMethod =
                'sendAudio';

            fieldName =
                'audio';
        }

        form.append(
            fieldName,
            fs.createReadStream(
                tempFilePath
            )
        );

        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/${apiMethod}`,
            form,
            {
                headers:
                    form.getHeaders(),

                timeout:
                    120000,

                maxContentLength:
                    Infinity,

                maxBodyLength:
                    Infinity
            }
        );

        console.log(
            `✅ Delivered ${type} to Telegram!`
        );
    } catch (err) {
        console.error(
            '❌ Telegram Direct API Error:',
            err.response?.data
                ?.description ||
            err.message
        );
    } finally {
        try {
            if (
                fs.existsSync(
                    tempFilePath
                )
            ) {
                fs.unlinkSync(
                    tempFilePath
                );
            }
        } catch (_) {}
    }
}


/* =========================================================
   SCHEDULE TIMER
========================================================= */

function clearScheduleTimer(id) {
    const timer =
        scheduleTimers.get(id);

    if (timer) {
        clearTimeout(timer);

        scheduleTimers.delete(id);
    }

    const retry =
        scheduleRetryTimers.get(id);

    if (retry) {
        clearTimeout(retry);

        scheduleRetryTimers.delete(id);
    }
}


function scheduleTimer(item) {
    clearScheduleTimer(
        item.id
    );

    if (
        item.status !==
        'pending'
    ) {
        return;
    }

    const target =
        new Date(
            item.datetime
        ).getTime();

    if (
        !Number.isFinite(
            target
        )
    ) {
        console.log(
            `❌ Invalid schedule date: ${item.id}`
        );

        return;
    }

    const remaining =
        target - Date.now();

    if (
        remaining <= 0
    ) {
        void sendScheduledMessage(
            item.id
        );

        return;
    }

    const delay =
        Math.min(
            remaining,
            2147483647
        );

    const timer =
        setTimeout(
            () => {
                const current =
                    loadSchedules()
                        .find(
                            x =>
                                x.id ===
                                item.id
                        );

                if (
                    !current ||
                    current.status !==
                        'pending'
                ) {
                    return;
                }

                const left =
                    new Date(
                        current.datetime
                    ).getTime() -
                    Date.now();

                if (
                    left <= 0
                ) {
                    void sendScheduledMessage(
                        current.id
                    );
                } else {
                    scheduleTimer(
                        current
                    );
                }
            },
            delay
        );

    scheduleTimers.set(
        item.id,
        timer
    );
}


function retrySchedule(
    id,
    delay = 10000
) {
    clearScheduleTimer(id);

    const timer =
        setTimeout(
            () => {
                scheduleRetryTimers.delete(
                    id
                );

                const current =
                    loadSchedules()
                        .find(
                            x =>
                                x.id ===
                                id
                        );

                if (
                    current &&
                    current.status ===
                        'pending'
                ) {
                    scheduleTimer(
                        current
                    );
                }
            },
            delay
        );

    scheduleRetryTimers.set(
        id,
        timer
    );
}


/* =========================================================
   SEND SCHEDULED MESSAGE
========================================================= */

async function sendScheduledMessage(id) {
    clearScheduleTimer(id);

    const schedules =
        loadSchedules();

    const item =
        schedules.find(
            x =>
                x.id ===
                id
        );

    if (
        !item ||
        item.status !==
            'pending'
    ) {
        return;
    }

    if (!activeSock) {
        console.log(
            `⏳ WhatsApp offline. Schedule ${id} waiting...`
        );

        retrySchedule(
            id,
            10000
        );

        return;
    }

    try {
        const number =
            normalizeNumber(
                item.number
            );

        if (
            !isValidPhoneNumber(
                number
            )
        ) {
            throw new Error(
                'Invalid WhatsApp number'
            );
        }

        item.status =
            'sending';

        item.lastAttemptAt =
            new Date()
                .toISOString();

        saveSchedules(
            schedules
        );

        await activeSock.sendMessage(
            jidFromNumber(
                number
            ),
            {
                text:
                    item.message
            }
        );

        item.status =
            'sent';

        item.sentAt =
            new Date()
                .toISOString();

        delete item.lastError;

        saveSchedules(
            schedules
        );

        console.log(
            `✅ SCHEDULED MESSAGE SENT: ${number}`
        );

        try {
            await bot.telegram.sendMessage(
                CHAT_ID,
                [
                    '✅ Scheduled WhatsApp message sent.',
                    '',
                    `📱 To: ${item.number}`,
                    `📅 ${item.date}`,
                    `⏰ ${item.time}`,
                    `💬 ${item.message}`,
                    `🆔 ID: ${item.id}`
                ].join('\n')
            );
        } catch (
            telegramError
        ) {
            console.error(
                'Telegram notification error:',
                telegramError.message
            );
        }
    } catch (error) {
        console.error(
            `❌ Scheduled send failed (${id}):`,
            error.message
        );

        const currentSchedules =
            loadSchedules();

        const current =
            currentSchedules.find(
                x =>
                    x.id ===
                    id
            );

        if (current) {
            current.status =
                'pending';

            current.lastError =
                error.message;

            current.lastAttemptAt =
                new Date()
                    .toISOString();

            saveSchedules(
                currentSchedules
            );
        }

        retrySchedule(
            id,
            10000
        );
    }
}


/* =========================================================
   LOAD ALL SCHEDULES
========================================================= */

function loadAllScheduleTimers() {
    const schedules =
        loadSchedules();

    let changed = false;

    for (
        const item of schedules
    ) {
        if (
            item.status ===
            'sending'
        ) {
            item.status =
                'pending';

            changed = true;
        }

        if (
            item.status ===
            'pending'
        ) {
            scheduleTimer(
                item
            );
        }
    }

    if (changed) {
        saveSchedules(
            schedules
        );
    }

    console.log(
        `📅 Loaded ${
            schedules.filter(
                x =>
                    x.status ===
                    'pending'
            ).length
        } pending schedule(s).`
    );
}


/* =========================================================
   TELEGRAM ACCESS
========================================================= */

function isAllowedChat(ctx) {
    return String(
        ctx.chat?.id
    ) === String(
        CHAT_ID
    );
}


/* =========================================================
   SCHEDULE WIZARD
========================================================= */

const scheduleSessions =
    new Map();


function startSchedule(ctx) {
    scheduleSessions.set(
        String(
            ctx.chat.id
        ),
        {
            step:
                'number',

            data:
                {}
        }
    );

    return ctx.reply(
        '📅 Schedule WhatsApp Message\n\n' +
        '📱 Enter WhatsApp number with country code:\n' +
        'Example: 919876543210'
    );
}


function isRealDate(
    dateString
) {
    const match =
        /^(\d{4})-(\d{2})-(\d{2})$/
            .exec(
                dateString
            );

    if (!match) {
        return false;
    }

    const year =
        Number(
            match[1]
        );

    const month =
        Number(
            match[2]
        );

    const day =
        Number(
            match[3]
        );

    const d =
        new Date(
            year,
            month - 1,
            day
        );

    return (
        d.getFullYear() ===
            year &&
        d.getMonth() ===
            month - 1 &&
        d.getDate() ===
            day
    );
}


async function handleScheduleInput(
    ctx
) {
    const chatId =
        String(
            ctx.chat.id
        );

    const session =
        scheduleSessions.get(
            chatId
        );

    if (!session) {
        return false;
    }

    const input =
        String(
            ctx.message?.text ||
            ''
        ).trim();

    if (!input) {
        return true;
    }


    /* NUMBER */

    if (
        session.step ===
        'number'
    ) {
        const number =
            normalizeNumber(
                input
            );

        if (
            !isValidPhoneNumber(
                number
            )
        ) {
            await ctx.reply(
                '❌ Invalid number.\n\n' +
                'Example: 919876543210'
            );

            return true;
        }

        session.data.number =
            number;

        session.step =
            'date';

        await ctx.reply(
            '📅 Enter date:\n' +
            'Format: YYYY-MM-DD\n\n' +
            'Example: 2026-09-25'
        );

        return true;
    }


    /* DATE */

    if (
        session.step ===
        'date'
    ) {
        if (
            !isRealDate(
                input
            )
        ) {
            await ctx.reply(
                '❌ Invalid date.\n\n' +
                'Use: YYYY-MM-DD\n' +
                'Example: 2026-09-25'
            );

            return true;
        }

        session.data.date =
            input;

        session.step =
            'time';

        await ctx.reply(
            '⏰ Enter time:\n' +
            'Format: HH:MM\n\n' +
            'Example: 22:30'
        );

        return true;
    }


    /* TIME */

    if (
        session.step ===
        'time'
    ) {
        if (
            !/^(?:[01]\d|2[0-3]):[0-5]\d$/
                .test(
                    input
                )
        ) {
            await ctx.reply(
                '❌ Invalid time.\n\n' +
                'Use 24-hour format.\n' +
                'Example: 22:30'
            );

            return true;
        }

        session.data.time =
            input;

        session.step =
            'message';

        await ctx.reply(
            '💬 Enter the WhatsApp message:'
        );

        return true;
    }


    /* MESSAGE */

    if (
        session.step ===
        'message'
    ) {
        session.data.message =
            input;

        const date =
            session.data.date;

        const time =
            session.data.time;

        const datetime =
            `${date}T${time}:00`;

        const target =
            new Date(
                datetime
            ).getTime();

        if (
            !Number.isFinite(
                target
            ) ||
            target <=
                Date.now()
        ) {
            await ctx.reply(
                '❌ Ye date/time already past hai.\n' +
                'Future date/time enter karo.'
            );

            scheduleSessions.delete(
                chatId
            );

            return true;
        }

        const schedules =
            loadSchedules();

        const duplicate =
            schedules.find(
                x =>
                    x.status ===
                        'pending' &&
                    normalizeNumber(
                        x.number
                    ) ===
                        session.data
                            .number &&
                    x.datetime ===
                        datetime &&
                    x.message ===
                        session.data
                            .message
            );

        if (duplicate) {
            await ctx.reply(
                '⚠️ Same pending schedule already exists.\n\n' +
                `🆔 ID: ${duplicate.id}`
            );

            scheduleSessions.delete(
                chatId
            );

            return true;
        }

        const item = {
            id:
                `${Date.now()}_${Math.random()
                    .toString(36)
                    .slice(2, 8)}`,

            number:
                session.data
                    .number,

            date,

            time,

            datetime,

            message:
                session.data
                    .message,

            status:
                'pending',

            createdAt:
                new Date()
                    .toISOString()
        };

        schedules.push(
            item
        );

        saveSchedules(
            schedules
        );

        scheduleTimer(
            item
        );

        scheduleSessions.delete(
            chatId
        );

        await ctx.reply(
            [
                '✅ SCHEDULED',
                '',
                `🆔 ID: ${item.id}`,
                `📱 To: ${item.number}`,
                `📅 Date: ${item.date}`,
                `⏰ Time: ${item.time}`,
                `💬 Message: ${item.message}`,
                '',
                'Status: PENDING'
            ].join('\n')
        );

        return true;
    }

    return true;
}


/* =========================================================
   TELEGRAM COMMANDS
========================================================= */

bot.command(
    'schedule',
    async (
        ctx
    ) => {
        if (
            !isAllowedChat(
                ctx
            )
        ) {
            return;
        }

        await startSchedule(
            ctx
        );
    }
);


bot.command(
    'list',
    async (
        ctx
    ) => {
        if (
            !isAllowedChat(
                ctx
            )
        ) {
            return;
        }

        const schedules =
            loadSchedules();

        if (
            !schedules.length
        ) {
            await ctx.reply(
                '📭 No scheduled messages.'
            );

            return;
        }

        const lines = [
            '📅 SCHEDULED MESSAGES',
            ''
        ];

        for (
            const item of
                schedules
        ) {
            lines.push(
                `🆔 ${item.id}`,
                `📱 ${item.number}`,
                `📅 ${item.date}`,
                `⏰ ${item.time}`,
                `💬 ${item.message}`,
                `📌 ${item.status}`,

                item.lastError
                    ? `⚠️ ${item.lastError}`
                    : '',

                ''
            );
        }

        await ctx.reply(
            lines.join('\n')
        );
    }
);


bot.command(
    'delete',
    async (
        ctx
    ) => {
        if (
            !isAllowedChat(
                ctx
            )
        ) {
            return;
        }

        const parts =
            String(
                ctx.message.text
            )
                .trim()
                .split(/\s+/);

        const id =
            parts[1];

        if (!id) {
            await ctx.reply(
                'Usage:\n/delete ID'
            );

            return;
        }

        const schedules =
            loadSchedules();

        const index =
            schedules.findIndex(
                x =>
                    x.id ===
                    id
            );

        if (
            index === -1
        ) {
            await ctx.reply(
                '❌ Schedule ID not found.'
            );

            return;
        }

        const item =
            schedules[index];

        if (
            item.status ===
            'sent'
        ) {
            await ctx.reply(
                '❌ Ye message already sent hai.'
            );

            return;
        }

        clearScheduleTimer(
            id
        );

        schedules.splice(
            index,
            1
        );

        saveSchedules(
            schedules
        );

        await ctx.reply(
            `✅ Deleted schedule:\n${id}`
        );
    }
);


bot.command(
    'status',
    async (
        ctx
    ) => {
        if (
            !isAllowedChat(
                ctx
            )
        ) {
            return;
        }

        const schedules =
            loadSchedules();

        const pending =
            schedules.filter(
                x =>
                    x.status ===
                    'pending'
            ).length;

        const sending =
            schedules.filter(
                x =>
                    x.status ===
                    'sending'
            ).length;

        const sent =
            schedules.filter(
                x =>
                    x.status ===
                    'sent'
            ).length;

        await ctx.reply(
            [
                '🤖 WISHFLOW STATUS',
                '',
                `WhatsApp: ${
                    activeSock
                        ? '🟢 Connected'
                        : '🔴 Disconnected'
                }`,
                `Pending: ${pending}`,
                `Sending: ${sending}`,
                `Sent: ${sent}`,
                `Pairing: ${
                    activeSock
                        ? 'Not needed'
                        : pairingPhoneNumber
                            ? 'Waiting / saved'
                            : 'Not registered'
                }`
            ].join('\n')
        );
    }
);


bot.command(
    'cancel',
    async (
        ctx
    ) => {
        if (
            !isAllowedChat(
                ctx
            )
        ) {
            return;
        }

        scheduleSessions.delete(
            String(
                ctx.chat.id
            )
        );

        await ctx.reply(
            '❌ Current scheduling cancelled.'
        );
    }
);


/* =========================================================
   TELEGRAM TEXT HANDLER
========================================================= */

bot.on(
    'text',
    async (
        ctx
    ) => {
        if (
            !isAllowedChat(
                ctx
            )
        ) {
            return;
        }

        const text =
            String(
                ctx.message?.text ||
                ''
            ).trim();

        if (
            text.startsWith('/')
        ) {
            return;
        }

        await handleScheduleInput(
            ctx
        );
    }
);


/* =========================================================
   START TELEGRAM BOT
========================================================= */

function startTelegramBot() {
    if (
        botStarted
    ) {
        return;
    }

    botStarted =
        true;

    bot.launch()
        .then(
            () => {
                console.log(
                    '🤖 Telegram bot controls online!'
                );
            }
        )
        .catch(
            (err) => {
                console.error(
                    'Telegram bot error:',
                    err.message
                );

                botStarted =
                    false;
            }
        );

    process.once(
        'SIGINT',
        () =>
            bot.stop(
                'SIGINT'
            )
    );

    process.once(
        'SIGTERM',
        () =>
            bot.stop(
                'SIGTERM'
            )
    );
}


/* =========================================================
   WHATSAPP
========================================================= */

async function startBot() {

    /*
     * Prevent duplicate WhatsApp startup.
     */

    if (
        whatsappStarting
    ) {
        console.log(
            '⏳ WhatsApp connection start already in progress...'
        );

        return;
    }

    whatsappStarting =
        true;


    /* LOAD AUTH STATE */

    let state;

    let saveCreds;

    try {
        ({
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                AUTH_DIR
            ));
    } catch (
        err
    ) {
        whatsappStarting =
            false;

        console.error(
            '❌ Auth state error:',
            err.message
        );

        setTimeout(
            () =>
                void startBot(),
            5000
        );

        return;
    }


    /* =====================================================
       IMPORTANT:
       If registered = true, NO PHONE NUMBER IS ASKED.
    ===================================================== */

    let phoneNumber =
        '';


    if (
        state.creds.registered
    ) {
        clearPairingPhone();

        console.log(
            '🔐 Saved WhatsApp session found.'
        );

        console.log(
            '✅ Pairing is NOT required.'
        );
    } else {

        /*
         * First try previously saved pairing number.
         */

        pairingPhoneNumber =
            pairingPhoneNumber ||
            loadPairingPhone();


        /*
         * Ask only if there is no saved number.
         */

        if (
            !pairingPhoneNumber
        ) {
            pairingPhoneNumber =
                normalizeNumber(
                    await question(
                        '📱 Enter your WhatsApp Phone Number with Country Code (e.g. 919876543210): '
                    )
                );

            if (
                !isValidPhoneNumber(
                    pairingPhoneNumber
                )
            ) {
                console.log(
                    '❌ Invalid phone number.'
                );

                console.log(
                    'Please restart and enter 8-15 digit country-code number.'
                );

                whatsappStarting =
                    false;

                return;
            }

            /*
             * Remember the pairing number
             * until authentication succeeds.
             */

            savePairingPhone(
                pairingPhoneNumber
            );
        }

        phoneNumber =
            pairingPhoneNumber;

        console.log(
            `📱 Pairing number saved: ${phoneNumber}`
        );
    }


    /* CREATE SOCKET */

    let sock;

    try {
        sock =
            makeWASocket({
                auth:
                    state,

                printQRInTerminal:
                    false,

                browser: [
                    'Ubuntu',
                    'Chrome',
                    '122.0.0.0'
                ],

                syncFullHistory:
                    false,

                markOnlineOnConnect:
                    true
            });
    } catch (
        err
    ) {
        whatsappStarting =
            false;

        console.error(
            '❌ WhatsApp socket error:',
            err.message
        );

        setTimeout(
            () =>
                void startBot(),
            5000
        );

        return;
    }

    activeSock =
        sock;

    whatsappStarting =
        false;


    /* SAVE CREDENTIALS */

    sock.ev.on(
        'creds.update',
        saveCreds
    );


    let codeRequested =
        false;


    /* =====================================================
       CONNECTION UPDATE
    ===================================================== */

    sock.ev.on(
        'connection.update',
        async (
            update
        ) => {

            const {
                connection,
                lastDisconnect
            } = update;


            /* =================================================
               PAIRING CODE
            ================================================= */

            if (
                !state.creds.registered &&
                !codeRequested &&
                phoneNumber
            ) {
                codeRequested =
                    true;

                setTimeout(
                    async () => {
                        try {

                            /*
                             * If registration completed
                             * while waiting, don't request
                             * another code.
                             */

                            if (
                                state.creds
                                    .registered
                            ) {
                                console.log(
                                    '🔐 WhatsApp already registered. Pairing code skipped.'
                                );

                                return;
                            }


                            const code =
                                await sock.requestPairingCode(
                                    phoneNumber
                                );


                            console.log(
                                ''
                            );

                            console.log(
                                '===================================='
                            );

                            console.log(
                                `🔑 YOUR WHATSAPP PAIRING CODE IS: ${code}`
                            );

                            console.log(
                                '===================================='
                            );

                            console.log(
                                ''
                            );

                        } catch (
                            err
                        ) {
                            codeRequested =
                                false;

                            console.error(
                                'Pairing Code Error:',
                                err.message
                            );
                        }
                    },
                    6000
                );
            }


            /* =================================================
               CONNECTION CLOSED
            ================================================= */

            if (
                connection ===
                'close'
            ) {

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;


                if (
                    activeSock ===
                    sock
                ) {
                    activeSock =
                        null;
                }


                /*
                 * User explicitly logged out.
                 * In this case a new pairing is required.
                 */

                if (
                    statusCode ===
                    DisconnectReason.loggedOut
                ) {
                    console.log(
                        '🚪 WhatsApp logged out.'
                    );

                    clearPairingPhone();

                    console.log(
                        '📱 New pairing will be required next time.'
                    );

                    return;
                }


                /*
                 * Normal disconnect:
                 * reconnect without asking for phone again.
                 */

                console.log(
                    `🔄 WhatsApp disconnected (${statusCode ?? 'unknown'}). Reconnecting...`
                );


                setTimeout(
                    () => {
                        if (
                            !activeSock &&
                            !whatsappStarting
                        ) {
                            void startBot();
                        }
                    },
                    3000
                );
            }


            /* =================================================
               CONNECTION OPEN
            ================================================= */

            else if (
                connection ===
                'open'
            ) {

                activeSock =
                    sock;


                /*
                 * Authentication completed.
                 * Remove temporary pairing-phone file.
                 */

                clearPairingPhone();


                console.log(
                    '✅ WhatsApp Online & Active!'
                );

                console.log(
                    '🔐 Session saved. Future restarts will use saved credentials.'
                );


                /*
                 * Reload pending schedules.
                 */

                loadAllScheduleTimers();
            }
        }
    );


    /* =====================================================
       INCOMING MESSAGES
    ===================================================== */

    sock.ev.on(
        'messages.upsert',
        async (
            m
        ) => {

            if (
                m.type !==
                'notify'
            ) {
                return;
            }


            for (
                const msg of
                    m.messages ||
                    []
            ) {

                if (
                    !msg.message ||
                    msg.key.fromMe
                ) {
                    continue;
                }


                const msgId =
                    msg.key.id;


                const sender =
                    cleanText(
                        msg.pushName ||
                        msg.key.remoteJid
                    );


                const msgType =
                    Object.keys(
                        msg.message
                    )[0];


                try {

                    /* TEXT */

                    if (
                        msgType ===
                            'conversation' ||
                        msgType ===
                            'extendedTextMessage'
                    ) {

                        const text =
                            msg.message
                                .conversation ||
                            msg.message
                                .extendedTextMessage
                                ?.text ||
                            '';


                        await sendToTelegramDirect(
                            'text',
                            `📩 From: ${sender}\n💬: ${text}`
                        );


                        messageStore.set(
                            msgId,
                            {
                                type:
                                    'text',

                                data:
                                    text,

                                sender
                            }
                        );
                    }


                    /* MEDIA */

                    else if (
                        [
                            'imageMessage',
                            'videoMessage',
                            'documentMessage',
                            'audioMessage'
                        ].includes(
                            msgType
                        )
                    ) {

                        console.log(
                            `🚀 Processing ${msgType} from ${sender}...`
                        );


                        const buffer =
                            await downloadMediaMessage(
                                msg,
                                'buffer',
                                {},
                                {
                                    reuploadRequest:
                                        sock.updateMediaMessage
                                }
                            );


                        const caption =
                            `📁 Received ${msgType.replace(
                                'Message',
                                ''
                            )}\n👤 From: ${sender}`;


                        await sendToTelegramDirect(
                            msgType,
                            buffer,
                            caption
                        );


                        messageStore.set(
                            msgId,
                            {
                                type:
                                    msgType,

                                data:
                                    buffer,

                                sender
                            }
                        );
                    }


                    /*
                     * Keep deleted-message data
                     * for 10 minutes.
                     */

                    setTimeout(
                        () =>
                            messageStore.delete(
                                msgId
                            ),
                        10 *
                            60 *
                            1000
                    );

                } catch (
                    e
                ) {
                    console.error(
                        'Processing error:',
                        e.message
                    );
                }
            }
        }
    );


    /* =====================================================
       DELETED MESSAGE CATCHER
    ===================================================== */

    sock.ev.on(
        'messages.update',
        async (
            updates
        ) => {

            for (
                const update of
                    updates
            ) {

                if (
                    update.update
                        ?.message ===
                        null ||
                    update.update
                        ?.protocolMessage
                        ?.type ===
                        0
                ) {

                    const deletedId =
                        update.key.id;


                    if (
                        !messageStore.has(
                            deletedId
                        )
                    ) {
                        continue;
                    }


                    const savedMsg =
                        messageStore.get(
                            deletedId
                        );


                    try {

                        if (
                            savedMsg.type ===
                            'text'
                        ) {

                            await sendToTelegramDirect(
                                'text',
                                `🚨 DELETED TEXT CATCHED!\n👤 From: ${savedMsg.sender}\n💬: ${savedMsg.data}`
                            );

                        } else {

                            await sendToTelegramDirect(
                                savedMsg.type,
                                savedMsg.data,
                                `🚨 DELETED ${savedMsg.type
                                    .replace(
                                        'Message',
                                        ''
                                    )
                                    .toUpperCase()} CATCHED!\n👤 From: ${savedMsg.sender}`
                            );
                        }

                    } catch (
                        err
                    ) {

                        console.error(
                            'Deleted-message forwarding error:',
                            err.message
                        );
                    }


                    messageStore.delete(
                        deletedId
                    );
                }
            }
        }
    );
}


/* =========================================================
   ERRORS
========================================================= */

process.on(
    'uncaughtException',
    (err) => {
        console.error(
            'Exception:',
            err.message
        );
    }
);


process.on(
    'unhandledRejection',
    (reason) => {
        console.error(
            'Rejection:',
            reason
        );
    }
);


/* =========================================================
   START
========================================================= */

startTelegramBot();

loadAllScheduleTimers();

void startBot();
