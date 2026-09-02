#!/usr/bin/env bash
set -euo pipefail

# One-time VPS setup for nginx + Let's Encrypt TLS.
#
# Run on the VPS from the repo root:
#   sudo ./scripts/setup-nginx.sh --email you@example.com
#
# Prerequisites:
#   - DNS for regenkans.nl and www.regenkans.nl points to this server
#   - Docker stack is running (docker compose -f docker-compose.prod.yml up -d)

DOMAIN="regenkans.nl"
WWW_DOMAIN="www.regenkans.nl"
WEBROOT="/var/www/html"
CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
NGINX_SITE="/etc/nginx/sites-available/regenkans"
NGINX_CONF="${REPO_ROOT}/nginx/regenkans.conf"

usage() {
  cat <<EOF
Usage: sudo $0 --email EMAIL

Sets up nginx and a Let's Encrypt certificate for ${DOMAIN}.

Options:
  --email EMAIL   Email address for Let's Encrypt registration (required)
  -h, --help      Show this help
EOF
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Error: run this script with sudo." >&2
    exit 1
  fi
}

parse_args() {
  CERTBOT_EMAIL=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --email)
        CERTBOT_EMAIL="${2:-}"
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        echo "Error: unknown argument: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  if [[ -z "${CERTBOT_EMAIL}" ]]; then
    echo "Error: --email is required." >&2
    usage >&2
    exit 1
  fi
}

install_packages() {
  echo "==> Installing nginx and certbot..."
  apt-get update -qq
  apt-get install -y nginx certbot python3-certbot-nginx curl
  mkdir -p "${WEBROOT}"
}

ensure_ssl_snippets() {
  if [[ ! -f /etc/letsencrypt/options-ssl-nginx.conf ]]; then
    echo "==> Creating /etc/letsencrypt/options-ssl-nginx.conf..."
    mkdir -p /etc/letsencrypt
    curl -fsSL \
      "https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/src/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf" \
      -o /etc/letsencrypt/options-ssl-nginx.conf
  fi

  if [[ ! -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
    echo "==> Generating DH parameters (this may take a minute)..."
    openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048
  fi
}

install_http_only_nginx() {
  echo "==> Installing temporary HTTP-only nginx config..."
  cat >"${NGINX_SITE}" <<EOF
server {
    listen 80;
    server_name ${DOMAIN} ${WWW_DOMAIN};

    location /.well-known/acme-challenge/ {
        root ${WEBROOT};
    }

    location / {
        return 301 https://${DOMAIN}\$request_uri;
    }
}
EOF

  ln -sf "${NGINX_SITE}" /etc/nginx/sites-enabled/regenkans
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable nginx
  systemctl reload nginx
}

obtain_certificate() {
  if [[ -f "${CERT_PATH}" ]]; then
    echo "==> Certificate already exists at ${CERT_PATH}, skipping certbot certonly."
    return
  fi

  echo "==> Obtaining Let's Encrypt certificate..."
  certbot certonly --webroot -w "${WEBROOT}" \
    --non-interactive --agree-tos -m "${CERTBOT_EMAIL}" \
    -d "${DOMAIN}" -d "${WWW_DOMAIN}"
}

install_full_nginx() {
  echo "==> Installing full nginx config..."
  if [[ ! -f "${NGINX_CONF}" ]]; then
    echo "Error: nginx config not found at ${NGINX_CONF}" >&2
    exit 1
  fi

  cp "${NGINX_CONF}" "${NGINX_SITE}"
  nginx -t
  systemctl reload nginx
}

configure_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    echo "==> Allowing nginx through ufw..."
    ufw allow "Nginx Full"
  fi
}

verify() {
  echo "==> Verifying HTTPS..."
  curl -fsSI "https://${DOMAIN}/" >/dev/null
  curl -fsSI "https://${DOMAIN}/api/health/" >/dev/null
  certbot certificates
  echo "Done. nginx and TLS are configured for https://${DOMAIN}/"
}

main() {
  parse_args "$@"
  require_root
  install_packages
  install_http_only_nginx
  obtain_certificate
  ensure_ssl_snippets
  install_full_nginx
  configure_firewall
  verify
}

main "$@"
