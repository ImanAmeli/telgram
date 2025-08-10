#!/usr/bin/env bash
set -euo pipefail

# رنگ‌ها
green(){ printf "\033[32m%s\033[0m\n" "$*"; }
red(){ printf "\033[31m%s\033[0m\n" "$*"; }

# 1) سوال‌های نصب
read -rp "Domain (مثلاً n1.example.com): " DOMAIN
read -rp "Email برای Let's Encrypt: " EMAIL
read -rp "Timezone (مثلاً Europe/London): " TZ
read -rp "Postgres password: " POSTGRES_PASSWORD
read -rp "Telegram bot token: " TELEGRAM_BOT_TOKEN
read -rp "Daily digest Chat ID (می‌تونی خالی بذاری و بعداً ست کنی): " DAILY_DIGEST_CHAT_ID
read -rp "OpenAI API key (اختیاری): " OPENAI_API_KEY || true

# 2) ساخت .env
cat > .env <<EOF
DOMAIN=${DOMAIN}
EMAIL=${EMAIL}
TZ=${TZ}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
DAILY_DIGEST_CHAT_ID=${DAILY_DIGEST_CHAT_ID}
OPENAI_API_KEY=${OPENAI_API_KEY}
EOF

green "✅ .env ساخته شد."

# 3) نصب Docker اگر نبود
if ! command -v docker >/dev/null 2>&1; then
  green "نصب Docker..."
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

green "✅ Docker آماده است."

# 4) بالا آوردن استک
docker compose pull
docker compose build
docker compose up -d
green "✅ استک بالا اومد. چند ثانیه برای گرفتن گواهی صبر کن..."

sleep 8
docker compose logs --tail=50 caddy || true

# 5) ست کردن وبهوک تلگرام
if [ -n "${TELEGRAM_BOT_TOKEN}" ]; then
  URL="https://${DOMAIN}/api/webhook"
  green "ست کردن وبهوک: ${URL}"
  curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    -d "url=${URL}" >/dev/null && green "✅ Webhook set"
fi

green "همه‌چیز آماده‌ست!
- Health: https://${DOMAIN}/api/health
- Webhook (تلگرام): https://${DOMAIN}/api/webhook
- Digest (GET دستی): https://${DOMAIN}/api/digest
نکته: اگر Chat ID رو نگذاشتی، داخل تلگرام به ربات /id بده تا عدد رو بگیری و در فایل .env ست کن بعد:
  docker compose up -d
"
