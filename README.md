> [!WARNING]
> **Disclaimer**
> 
> This tool is strictly developed for personal backup and educational purposes only. The developer is not responsible for any misuse, account bans, or privacy violations. Use it responsibly.

# 🚀 WhatsApp Multi-Device Anti-Delete & Media Forwarder

A lightweight, high-speed, and fully automated tool that monitors your WhatsApp in real-time and instantly mirrors deleted messages, media, and status updates directly to your private Telegram chat.

---

## ✨ Key Features & Benefits

* 🚨 **Anti-Delete Engine:** Instantly intercepts and captures any text, image, video, or audio file deleted using *"Delete for Everyone"*.
* 📲 **Status & Story Forwarder:** Automatically catches and forwards WhatsApp Status/Story updates directly to your Telegram.
* ⚡ **Direct Telegram Forwarding:** Real-time, instant delivery of incoming messages and media directly to your personal Telegram account.
* 🔑 **Seamless Pairing Code:** Skip the QR scan hassle—log in effortlessly using a simple 8-digit WhatsApp Pairing Code.
* 🔄 **Persistent Session Management:** Credentials auto-save securely inside `auth_info_baileys` so you only log in once.
* ⚙️ **One-Click Environment Setup:** Automated deployment script featuring built-in `.env` generation—just run `./run.sh` and go.

## 🤖 Telegram Bot Setup

Open **@BotFather** on Telegram.

Send:

/start

Then:

/newbot

Follow the instructions to create your bot.

Example username:

watotg_scheduler_bot

BotFather will provide an **HTTP API Token**. Enter this token as the Telegram Bot Token during setup.

⚠️ Keep your Telegram Bot Token private. Do not share it with anyone.

## 🆔 Telegram Chat ID

Open **@userinfobot** on Telegram and send:

/start

The bot will display your Telegram ID.

Use that ID as the Telegram Chat ID during setup.

## 📅 WhatsApp Message Scheduler

The Telegram bot can be used to schedule WhatsApp messages for a specific date and time.

### /schedule

To create a new scheduled message:

/schedule

The bot will ask for:

1. WhatsApp Number
2. Date — YYYY-MM-DD
3. Time — HH:MM
4. Message

Example:

/schedule

1234567890

2026-10-05

18:30

Hello, tomorrow is our meeting.

The scheduled message will be sent to the specified WhatsApp number at the configured date and time.

### /list

View all scheduled messages:

/list

This displays the schedule ID, recipient, date, time, message, and status.

### /delete ID

Delete an existing schedule:

/delete 3

Here, `3` is the schedule ID.

### /status

Check the current WhatsApp connection and scheduler status:

/status

### /cancel

Cancel the current scheduling process:

/cancel

## 📋 Telegram Commands

/schedule    → Create a new scheduled WhatsApp message

/list        → View scheduled messages

/delete ID   → Delete a scheduled message

/status      → View WhatsApp and scheduler status

/cancel      → Cancel the current scheduling process
---

## ⚡ Quick Installation (One-Line Command)

Just run this single command in Termux or Linux terminal:

```bash
apt update -y && apt upgrade -y && pkg install git -y && git clone https://github.com/cdh4cks/watotg.git && cd watotg && chmod +x run.sh && ./run.sh
```

---

## 📖 How To Use

1. Paste and run the one-line command above in Termux/Linux.
2. Enter your **Telegram Bot Token** and **Chat ID** when prompted.
3. Enter your **WhatsApp Number** with country code (e.g., `911234567890`).
4. Enter the **8-digit Pairing Code** in WhatsApp (**Settings > Linked Devices > Link with Phone Number**).
**Don't Close/End you terminal session Otherwise it will stop working.**
---

## 👨‍💻 Author

Developed by **[cdh4cks Suraj](https://github.com/cdh4cks)**
