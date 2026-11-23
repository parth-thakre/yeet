#!/usr/bin/env bash
# One-shot: put Yeet behind a Cloudflare Tunnel at https://<HOSTNAME>, with published
# pages on a second hostname, https://<CONTENT_HOSTNAME>.
#
# Needs a Cloudflare API token with:
#   Account > Cloudflare Tunnel > Edit
#   Zone    > DNS               > Edit   (for the zone)
# Pass it in CF_API_TOKEN or in a file named by CF_API_TOKEN_FILE. It is never printed.
# If DNS is managed by a different token, put that one in CF_DNS_API_TOKEN (defaults to CF_API_TOKEN).
#
# CONTENT_HOSTNAME defaults to the first label of HOSTNAME plus -content on the same parent
# (yeet.example.com -> yeet-content.example.com), which Universal SSL covers. A hostname in
# another zone also works if that zone is in the tunnel's Cloudflare account and the DNS token
# can edit it. CONTENT_HOSTNAME=none skips it, and published pages then share the account origin.
#
# Usage (from deploy/):  HOSTNAME=yeet.example.com bash cloudflare-tunnel.sh
set -euo pipefail
# Everything written here is a credential or sits next to one: readable by this user only.
umask 077

HOSTNAME="${HOSTNAME:?set HOSTNAME, e.g. yeet.example.com}"
# Bash fills HOSTNAME with the machine name when it isn't passed in, so insist on a DNS name.
case "$HOSTNAME" in *.*) ;; *) echo "error: set HOSTNAME to the full public hostname, e.g. HOSTNAME=yeet.example.com" >&2; exit 1 ;; esac
# Yeet only accepts lowercase origins, so normalize every name before it reaches DNS or .env.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
HOSTNAME="$(lower "$HOSTNAME")"
CONTENT_HOSTNAME="$(lower "${CONTENT_HOSTNAME:-}")"
ZONE_NAME="$(lower "${ZONE_NAME:-}")"
CONTENT_ZONE_NAME="$(lower "${CONTENT_ZONE_NAME:-}")"
TUNNEL_NAME="${TUNNEL_NAME:-yeet}"
ENV_FILE="${ENV_FILE:-.env}"
ZONE_NAME="${ZONE_NAME:-$(echo "$HOSTNAME" | awk -F. '{print $(NF-1)"."$NF}')}"
if [ -z "${CONTENT_HOSTNAME:-}" ]; then
  [ "$HOSTNAME" != "$ZONE_NAME" ] || { echo "error: $HOSTNAME is the zone apex; set CONTENT_HOSTNAME (or CONTENT_HOSTNAME=none)" >&2; exit 1; }
  CONTENT_HOSTNAME="${HOSTNAME%%.*}-content.${HOSTNAME#*.}"
fi
if [ "$CONTENT_HOSTNAME" = none ]; then
  CONTENT_HOSTNAME=
else
  [ "$CONTENT_HOSTNAME" != "$HOSTNAME" ] || { echo "error: CONTENT_HOSTNAME must differ from HOSTNAME" >&2; exit 1; }
  case "$CONTENT_HOSTNAME" in *.*) ;; *) echo "error: CONTENT_HOSTNAME must be a full hostname, e.g. yeet-content.example.com" >&2; exit 1 ;; esac
  # A hostname inside ZONE_NAME uses that zone, so a ZONE_NAME override such as example.co.uk carries over.
  case "$CONTENT_HOSTNAME" in
    "$ZONE_NAME" | *."$ZONE_NAME") CONTENT_ZONE_NAME="${CONTENT_ZONE_NAME:-$ZONE_NAME}" ;;
    *) CONTENT_ZONE_NAME="${CONTENT_ZONE_NAME:-$(echo "$CONTENT_HOSTNAME" | awk -F. '{print $(NF-1)"."$NF}')}" ;;
  esac
fi
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
# A tunnel can only serve hostnames from zones in its own account, so an override must agree.
zone_acct="$(jq -r '.result[0].account.id // empty' <<<"$zone_json")"
[ -z "$zone_acct" ] || [ "$zone_acct" = "$acct" ] || fail "zone $ZONE_NAME is in Cloudflare account $zone_acct, but CF_ACCOUNT_ID is $acct; the tunnel must be in the zone's account"
if [ -z "$zone_acct" ]; then
  # The zone didn't name its account, so ask for it within the chosen account instead.
  owned="$(cfdns "$api/zones?name=$ZONE_NAME&account.id=$acct" | jq -r '.result[0].id // empty')"
  [ "$owned" = "$zone" ] || fail "zone $ZONE_NAME is not in Cloudflare account $acct; the tunnel must be in the zone's account"
fi

# Check a content hostname in another zone before changing anything. Its CNAME can only route
# through this tunnel when that zone is in the tunnel's Cloudflare account.
content_zone="$zone"
if [ -n "$CONTENT_HOSTNAME" ] && [ "$CONTENT_ZONE_NAME" != "$ZONE_NAME" ]; then
  content_zone_json="$(cfdns "$api/zones?name=$CONTENT_ZONE_NAME")"
  content_zone="$(jq -r '.result[0].id // empty' <<<"$content_zone_json")"
  [ -n "$content_zone" ] || fail "zone $CONTENT_ZONE_NAME not visible to this token (needs Zone > DNS > Edit on it)"
  content_acct="$(jq -r '.result[0].account.id // empty' <<<"$content_zone_json")"
  [ "$content_acct" = "$acct" ] || fail "zone $CONTENT_ZONE_NAME must be in the same Cloudflare account as the tunnel ($acct)"
fi

tid="$(cf "$api/accounts/$acct/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false" | jq -r '.result[0].id // empty')"
if [ -z "$tid" ]; then
  body="$(jq -cn --arg n "$TUNNEL_NAME" '{name:$n, config_src:"local"}')"
  tid="$(cf -X POST --data "$body" "$api/accounts/$acct/cfd_tunnel" | jq -r '.result.id // empty')"
  [ -n "$tid" ] || fail "could not create tunnel (token needs Cloudflare Tunnel: Edit)"
  echo "created tunnel $TUNNEL_NAME ($tid)"
else
  echo "using existing tunnel $TUNNEL_NAME ($tid)"
fi

# Create or update a proxied CNAME from $2 to the tunnel in zone $1.
route_dns() {
  local record rid
  record="$(jq -cn --arg n "$2" --arg c "$tid.cfargotunnel.com" '{type:"CNAME", name:$n, content:$c, proxied:true, ttl:1}')"
  rid="$(cfdns "$api/zones/$1/dns_records?name=$2" | jq -r '.result[0].id // empty')"
  if [ -n "$rid" ]; then cfdns -X PATCH --data "$record" "$api/zones/$1/dns_records/$rid" > /dev/null; else cfdns -X POST --data "$record" "$api/zones/$1/dns_records" > /dev/null; fi
  echo "dns: $2 CNAME $tid.cfargotunnel.com (proxied)"
}
route_dns "$zone" "$HOSTNAME"

content_ingress=
if [ -n "$CONTENT_HOSTNAME" ]; then
  route_dns "$content_zone" "$CONTENT_HOSTNAME"
  # Same service: cloudflared keeps the Host header, and Yeet routes on it.
  content_ingress="  - hostname: $CONTENT_HOSTNAME
    service: http://yeet:3000
"
fi

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
${content_ingress}  - service: http_status:404
CONFIG
echo "wrote cloudflared/config.yml and cloudflared/$tid.json"

touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
# mktemp creates the file 0600 under a fresh name, so the rename keeps .env private.
env_tmp="$(mktemp "$ENV_FILE.XXXXXX")"
trap 'rm -f "$env_tmp"' EXIT
grep -v -e '^CLOUDFLARED_TOKEN=' -e '^CLOUDFLARED_UID=' -e '^YEET_ORIGIN=' -e '^YEET_CONTENT_ORIGIN=' "$ENV_FILE" > "$env_tmp" || true
printf 'YEET_ORIGIN=https://%s\n' "$HOSTNAME" >> "$env_tmp"
if [ -n "$CONTENT_HOSTNAME" ]; then printf 'YEET_CONTENT_ORIGIN=https://%s\n' "$CONTENT_HOSTNAME" >> "$env_tmp"; fi
printf 'CLOUDFLARED_UID=%s\n' "$(id -u)" >> "$env_tmp"
mv "$env_tmp" "$ENV_FILE"
if [ -n "$CONTENT_HOSTNAME" ]; then
  echo "wrote YEET_ORIGIN, YEET_CONTENT_ORIGIN and CLOUDFLARED_UID to $ENV_FILE"
else
  echo "wrote YEET_ORIGIN and CLOUDFLARED_UID to $ENV_FILE; removed YEET_CONTENT_ORIGIN"
fi

docker compose --env-file "$ENV_FILE" --profile cloudflare up -d --wait
# config.yml is a bind mount that cloudflared reads only at startup, and Compose doesn't
# recreate a running connector for a changed file. Recreate it so the new ingress applies.
docker compose --env-file "$ENV_FILE" --profile cloudflare up -d --wait --no-deps --force-recreate cloudflared
echo "Yeet is now served at https://$HOSTNAME"
if [ -n "$CONTENT_HOSTNAME" ]; then
  echo "Published pages are served from https://$CONTENT_HOSTNAME"
else
  echo "warning: no content hostname, so published pages run on the account origin" >&2
fi
