#!/usr/bin/env bash
# One-shot: put Yeet behind a Cloudflare Tunnel at https://<HOSTNAME>.
#
# Needs a Cloudflare API token with:
#   Account > Cloudflare Tunnel > Edit
#   Zone    > DNS               > Edit   (for the zone)
# Pass it in CF_API_TOKEN or in a file named by CF_API_TOKEN_FILE. It is never printed.
# If DNS is managed by a different token, put that one in CF_DNS_API_TOKEN (defaults to CF_API_TOKEN).
#
# Usage (from deploy/):  HOSTNAME=yeet.example.com bash cloudflare-tunnel.sh
set -euo pipefail
# Everything written here is a credential or sits next to one: readable by this user only.
umask 077

HOSTNAME="${HOSTNAME:?set HOSTNAME, e.g. yeet.example.com}"
TUNNEL_NAME="${TUNNEL_NAME:-yeet}"
ENV_FILE="${ENV_FILE:-.env}"
ZONE_NAME="${ZONE_NAME:-$(echo "$HOSTNAME" | awk -F. '{print $(NF-1)"."$NF}')}"
if [ -z "${CF_API_TOKEN:-}" ] && [ -n "${CF_API_TOKEN_FILE:-}" ]; then CF_API_TOKEN="$(tr -d '[:space:]' < "$CF_API_TOKEN_FILE")"; fi
: "${CF_API_TOKEN:?set CF_API_TOKEN or CF_API_TOKEN_FILE}"
CF_DNS_API_TOKEN="${CF_DNS_API_TOKEN:-$CF_API_TOKEN}"

api=https://api.cloudflare.com/client/v4
fail() { echo "error: $*" >&2; exit 1; }
# Every call goes through here; on a Cloudflare error we print the message and stop.
cf() { CF_TOKEN_IN_USE="$CF_API_TOKEN" cf_call "$@"; }
cfdns() { CF_TOKEN_IN_USE="$CF_DNS_API_TOKEN" cf_call "$@"; }
cf_call() {
  local out
  out="$(curl -sS -H "Authorization: Bearer $CF_TOKEN_IN_USE" -H "Content-Type: application/json" "$@")" || fail "request failed: $*"
  if [ "$(jq -r '.success' <<<"$out")" != "true" ]; then
    fail "$(jq -r '[.errors[]?.message] | join("; ")' <<<"$out") (while calling $*)"
  fi
  printf '%s' "$out"
}

zone_json="$(cfdns "$api/zones?name=$ZONE_NAME")"
zone="$(jq -r '.result[0].id // empty' <<<"$zone_json")"
[ -n "$zone" ] || fail "zone $ZONE_NAME not visible to this token (needs Zone > DNS > Edit on it)"
# Account-owned tokens cannot list /accounts, so take the account from the zone.
acct="${CF_ACCOUNT_ID:-$(jq -r '.result[0].account.id // empty' <<<"$zone_json")}"
[ -n "$acct" ] || fail "could not determine the account id; set CF_ACCOUNT_ID"

tid="$(cf "$api/accounts/$acct/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false" | jq -r '.result[0].id // empty')"
if [ -z "$tid" ]; then
  body="$(jq -cn --arg n "$TUNNEL_NAME" '{name:$n, config_src:"local"}')"
  tid="$(cf -X POST --data "$body" "$api/accounts/$acct/cfd_tunnel" | jq -r '.result.id // empty')"
  [ -n "$tid" ] || fail "could not create tunnel (token needs Cloudflare Tunnel: Edit)"
  echo "created tunnel $TUNNEL_NAME ($tid)"
else
  echo "using existing tunnel $TUNNEL_NAME ($tid)"
fi


record="$(jq -cn --arg n "$HOSTNAME" --arg c "$tid.cfargotunnel.com" '{type:"CNAME", name:$n, content:$c, proxied:true, ttl:1}')"
rid="$(cfdns "$api/zones/$zone/dns_records?name=$HOSTNAME" | jq -r '.result[0].id // empty')"
if [ -n "$rid" ]; then cfdns -X PATCH --data "$record" "$api/zones/$zone/dns_records/$rid" > /dev/null; else cfdns -X POST --data "$record" "$api/zones/$zone/dns_records" > /dev/null; fi
echo "dns: $HOSTNAME CNAME $tid.cfargotunnel.com (proxied)"

ctoken="$(cf "$api/accounts/$acct/cfd_tunnel/$tid/token" | jq -r '.result // empty')"
[ -n "$ctoken" ] || fail "could not fetch the connector token"

# The connector token is base64 JSON {a: account, t: tunnel id, s: secret}; turn it into a credentials file.
mkdir -p cloudflared; chmod 700 cloudflared
printf '%s' "$ctoken" | base64 -d 2>/dev/null | jq '{AccountTag: .a, TunnelID: .t, TunnelSecret: .s}' > "cloudflared/$tid.json" || fail "could not decode the connector token"
chmod 600 "cloudflared/$tid.json"
cat > cloudflared/config.yml <<CONFIG
tunnel: $tid
credentials-file: /etc/cloudflared/$tid.json
ingress:
  - hostname: $HOSTNAME
    service: http://yeet:3000
  - service: http_status:404
CONFIG
echo "wrote cloudflared/config.yml and cloudflared/$tid.json"

touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
# mktemp creates the file 0600 under a fresh name, so the rename keeps .env private.
env_tmp="$(mktemp "$ENV_FILE.XXXXXX")"
trap 'rm -f "$env_tmp"' EXIT
grep -v -e '^CLOUDFLARED_TOKEN=' -e '^CLOUDFLARED_UID=' -e '^YEET_ORIGIN=' "$ENV_FILE" > "$env_tmp" || true
printf 'YEET_ORIGIN=https://%s
CLOUDFLARED_UID=%s
' "$HOSTNAME" "$(id -u)" >> "$env_tmp"
mv "$env_tmp" "$ENV_FILE"
echo "wrote YEET_ORIGIN and CLOUDFLARED_UID to $ENV_FILE"

docker compose --env-file "$ENV_FILE" --profile cloudflare up -d --wait
echo "Yeet is now served at https://$HOSTNAME"
