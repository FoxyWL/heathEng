#!/usr/bin/env bash
# Установка релея Hearth на VPS одной командой (Ubuntu, Debian, Fedora, CentOS, Alma, Rocky):
#   curl -fsSL https://raw.githubusercontent.com/FoxyWL/heathEng/main/relay/install.sh | sudo bash
# Ставит Node.js (если нет), скачивает релей в /opt/hearth-relay, создаёт службу systemd, открывает порты в ufw/firewalld
# и печатает ссылку-приглашение для Hearth. Повторный запуск обновляет релей и оставляет прежний токен.
# Удаление: curl -fsSL .../install.sh | sudo bash -s -- --uninstall
# Переменные: PUBLIC_HOST (адрес для друзей, по умолчанию внешний IP), CONTROL_PORT (7000), PORT_MIN/PORT_MAX (20000/20100), RELAY_TOKEN.
set -euo pipefail

REPO_RAW="${HEARTH_RAW:-https://raw.githubusercontent.com/FoxyWL/heathEng/main}"
DIR="${HEARTH_RELAY_DIR:-/opt/hearth-relay}"
ENV_FILE="${HEARTH_RELAY_ENV:-/etc/hearth-relay.env}"
SERVICE=hearth-relay
CONTROL_PORT="${CONTROL_PORT:-7000}"
PORT_MIN="${PORT_MIN:-20000}"
PORT_MAX="${PORT_MAX:-20100}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nОшибка: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" -eq 0 ] || die "запустите от root: ... | sudo bash"

if [ "${1:-}" = "--uninstall" ]; then
  say "Удаляю релей"
  if have systemctl && [ -z "${HEARTH_NO_SYSTEMD:-}" ]; then
    systemctl disable --now "$SERVICE" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE.service"
    systemctl daemon-reload || true
  elif [ -f "$DIR/relay.pid" ]; then
    kill "$(cat "$DIR/relay.pid")" 2>/dev/null || true
  fi
  rm -rf "$DIR" "$ENV_FILE"
  echo "Готово. Порты в firewall закройте сами, если открывали вручную."
  exit 0
fi

# --- Node.js 20+
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! have node || [ "$(node_major)" -lt 20 ]; then
  say "Ставлю Node.js 22"
  if have apt-get; then
    apt-get update -y >/dev/null
    apt-get install -y curl ca-certificates >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y nodejs >/dev/null
  elif have dnf || have yum; then
    PM=$(have dnf && echo dnf || echo yum)
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null
    "$PM" install -y nodejs >/dev/null
  else
    die "не знаю, как поставить Node.js в этой системе. Поставьте Node.js 20+ (nodejs.org) и запустите скрипт снова"
  fi
fi
[ "$(node_major)" -ge 20 ] || die "нужен Node.js 20 или новее, сейчас $(node -v 2>/dev/null || echo нет)"

# --- файлы релея (при HEARTH_RELAY_SRC берём из локальной папки: для проверок без интернета)
say "Скачиваю релей в $DIR"
mkdir -p "$DIR/relay" "$DIR/shared"
fetch() { # путь в репозитории
  if [ -n "${HEARTH_RELAY_SRC:-}" ]; then cp "$HEARTH_RELAY_SRC/$1" "$DIR/$1"
  else curl -fsSL "$REPO_RAW/$1" -o "$DIR/$1"; fi
}
fetch relay/relay.js
fetch shared/util.js

# --- адрес и токен
if [ -z "${PUBLIC_HOST:-}" ]; then
  for u in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
    PUBLIC_HOST=$(curl -fsS --max-time 6 "$u" 2>/dev/null | tr -d '[:space:]' || true)
    case "$PUBLIC_HOST" in *[!0-9.]*|'') PUBLIC_HOST='' ;; *) break ;; esac
  done
fi
[ -n "${PUBLIC_HOST:-}" ] || die "не удалось определить внешний IP. Запустите с PUBLIC_HOST=ваш.ip ... | sudo bash"

TOKEN="${RELAY_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$ENV_FILE" ]; then TOKEN=$(sed -n 's/^RELAY_TOKEN=//p' "$ENV_FILE" | head -n1); fi
if [ -z "$TOKEN" ]; then TOKEN=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n'); fi

umask 077
cat > "$ENV_FILE" <<ENV
RELAY_TOKEN=$TOKEN
PUBLIC_HOST=$PUBLIC_HOST
RELAY_DOMAIN=$PUBLIC_HOST
CONTROL_PORT=$CONTROL_PORT
PORT_MIN=$PORT_MIN
PORT_MAX=$PORT_MAX
ENV
umask 022

# --- служба
NODE_BIN=$(command -v node)
if have systemctl && [ -z "${HEARTH_NO_SYSTEMD:-}" ]; then
  say "Создаю службу $SERVICE"
  cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Hearth relay
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $DIR/relay/relay.js
Restart=always
RestartSec=3
DynamicUser=yes

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  systemctl restart "$SERVICE"
  sleep 2
  systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 20 --no-pager || true; die "служба не запустилась"; }
else
  say "systemd нет: запускаю релей в фоне"
  [ -f "$DIR/relay.pid" ] && kill "$(cat "$DIR/relay.pid")" 2>/dev/null || true
  ( set -a; . "$ENV_FILE"; set +a; nohup "$NODE_BIN" "$DIR/relay/relay.js" >"$DIR/relay.log" 2>&1 & echo $! >"$DIR/relay.pid" )
  sleep 2
fi

# --- firewall
if have ufw && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "Открываю порты в ufw"
  ufw allow "$CONTROL_PORT/tcp" >/dev/null
  ufw allow "$PORT_MIN:$PORT_MAX/tcp" >/dev/null
  ufw allow "$PORT_MIN:$PORT_MAX/udp" >/dev/null
  ufw allow 7001/udp >/dev/null
elif have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
  say "Открываю порты в firewalld"
  firewall-cmd --permanent --add-port="$CONTROL_PORT/tcp" --add-port="$PORT_MIN-$PORT_MAX/tcp" --add-port="$PORT_MIN-$PORT_MAX/udp" >/dev/null
  firewall-cmd --reload >/dev/null
fi

LINK="hearth-relay://$PUBLIC_HOST:$CONTROL_PORT?token=$TOKEN"
cat <<DONE

Релей работает.

Ссылка для Hearth (раздел «Туннели» → «Подключить по ссылке»):

  $LINK

Если у хостинга есть свой firewall в панели управления, откройте там: $CONTROL_PORT/tcp и $PORT_MIN-$PORT_MAX по tcp и udp.
Ссылку никому не показывайте: токен даёт право открывать порты на этом сервере.
DONE
