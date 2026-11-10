#!/bin/bash 

### ========================================================
### BANNER & WELCOME SCREEN
### ========================================================

if ! command -v figlet &> /dev/null
then
echo "[*] First time setup, installing required components..."
apt update && apt install figlet -y &> /dev/null
fi 

clear
echo -e "\e[1;32m"
figlet -f slant "Cdh4cks"
echo -e "\e[1;36m========================================"
echo -e "         CREATED BY SURAJ          "
echo -e "========================================\e[0m"
echo "" 

### ========================================================
### CORE REQUIREMENTS CHECK (NODEJS & NANO)
### ========================================================

echo "[*] Checking basic requirements..." 

### Checking Node.js

if ! command -v node &> /dev/null
then
echo "[-] Node.js not found! Installing..."
apt update && apt install nodejs -y
else
echo "[+] Node.js is already installed."
fi 

### Checking Nano

if ! command -v nano &> /dev/null
then
echo "[-] Nano not found! Installing..."
apt install nano -y
else
echo "[+] Nano is already installed."
fi 

### ========================================================
### NPM PACKAGES INSTALLATION (FIXED FOR GIT DEPENDENCY)
### ========================================================

echo -e "\n[*] Installing packages, this may take a moment..." 

### 🔥 Fix for EALLOWGIT error in newer npm versions
npm config set allow-git all &> /dev/null

### Step 1: Global PM2 Installation

if ! command -v pm2 &> /dev/null
then
echo "[*] Installing PM2 globally..."
npm install -g pm2 --legacy-peer-deps
else
echo "[+] PM2 is already installed."
fi 

### Step 2: Production packages

echo "[*] Installing local production dependencies..."
npm install --production --no-audit --no-fund --legacy-peer-deps 

### ========================================================
### TELEGRAM CONFIGURATION (.env FILE CREATION)
### ========================================================

if [ ! -f ".env" ]; then
echo -e "\n\e[1;33m[!] Configuration file (.env) not found. Starting setup...\e[0m" 

### Getting Telegram Bot Token

echo -n "👉 Enter your Telegram Bot Token: "
read BOT_TOKEN 

### Getting Telegram Chat ID

echo -n "👉 Enter your Telegram Chat ID: "
read CHAT_ID 

# Creating .env file automatically

echo "TELEGRAM_BOT_TOKEN=$BOT_TOKEN" > .env
echo "TELEGRAM_CHAT_ID=$CHAT_ID" >> .env

echo -e "\e[1;32m[+] .env file created successfully!\e[0m\n"

else
echo -e "\n[+] .env file already exists."
fi 

### ========================================================
### STARTING THE MAIN TOOL
### ========================================================

echo -e "\e[1;32m[*] All requirements installed successfully.\e[0m"
echo "[*] Starting the tool..."
echo "========================================" 

### Running the main Node.js application

node index.js
