# Deploy: Ubuntu + Caddy / Pterodactyl

## Что делает сервис
- Берет `SOURCE_URL` (страница oversub/remnawave),
- конвертирует ссылки в:
  - `v2ray_links.txt`
  - `v2ray_subscription.b64`
- обновляет их каждые `UPDATE_INTERVAL_MINUTES`,
- отдает по HTTP:
  - `/<LINKS_FILE>` (по умолчанию `/v2ray_links.txt`)
  - `/<B64_FILE>` (по умолчанию `/v2ray_subscription.b64`)
  - `/healthz`

## Вариант 1: Ubuntu + systemd + Caddy (Bun)

1. Установи Bun:
```bash
curl -fsSL https://bun.sh/install | bash
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
bun --version
```

2. Размести репозиторий:
```bash
sudo mkdir -p /opt/subs
sudo chown -R $USER:$USER /opt/subs
cd /opt/subs
git clone <your_repo_url> .
```

3. Создай env-файл:
```bash
cp deploy/.env.example .env
nano .env
```

4. Установи systemd unit:
```bash
sudo cp deploy/subscription.service /etc/systemd/system/subscription.service
sudo systemctl daemon-reload
sudo systemctl enable --now subscription.service
sudo systemctl status subscription.service
```

5. Добавь в Caddyfile:
```caddy
subs.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8080
}
```

6. Применить Caddy:
```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Проверка:
```bash
curl -s https://subs.example.com/healthz
curl -s https://subs.example.com/v2ray_subscription.b64 | head
```

## Вариант 2: контейнер (Docker/Pterodactyl)

Локально (или в ноде Pterodactyl) образ запускается так:
```bash
docker build -t subs-updater:latest .
docker run -d --name subs-updater \
  -p 8080:8080 \
  -e SOURCE_URL="https://oversub.cloud/replace_me" \
  -e UPDATE_INTERVAL_MINUTES=30 \
  -e SCHEMES="vless,vmess,trojan,ss" \
  subs-updater:latest
```

В Pterodactyl через egg:
1. Импортируй файл:
   - `deploy/pterodactyl/egg-subs-updater-bun.json`
2. Создай сервер на этом egg.
3. Выдели allocation порт (он пойдет в `{{SERVER_PORT}}`).
4. В Startup/Variables задай:
   - `REPO_URL` (например `https://github.com/<user>/<repo>.git`)
   - `REPO_BRANCH` (например `main`)
   - `MAIN_FILE=subscription-service.js`
   - `AUTO_UPDATE=0` (или `1`, если хочешь `git pull` при каждом старте)
   - `USER_UPLOAD=0` (ставь `1`, если файлы грузишь вручную и без git)
   - `SOURCE_URL` (твоя oversub ссылка)
5. Запусти сервер: install-скрипт сам скачает код из GitHub в `/home/container`.
6. Проверь в консоли строку `"[server] listening on"`.
7. В Caddy сделай `reverse_proxy` на `IP_ноды:выделенный_порт`.
8. Для обновления кода из GitHub нажми `Reinstall` у сервера (egg заново подтянет ветку).

Пример Caddy:
```caddy
subs.example.com {
    encode gzip
    reverse_proxy <NODE_PUBLIC_IP>:<PTERO_ALLOCATED_PORT>
}
```

## Обновление
```bash
cd /opt/subs
git pull
sudo systemctl restart subscription.service
```
