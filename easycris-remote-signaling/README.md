# easyCris Remote Signaling

Standalone cloud signaling service for internet remote sessions. This is a server deployment artifact only. It is not bundled with the easyCris desktop binary.

The desktop app uses this service only for internet mode rendezvous:

- invite creation
- HTTPS invite landing pages
- WebSocket signaling relay for host, guest, SDP, ICE, and heartbeat messages
- short-lived STUN/TURN configuration for approved participants

It does not store or relay video, input events, screenshots, project data, or recordings.

## Repository Layout

```text
easycris-remote-signaling/
  Cargo.toml
  Dockerfile
  docker-compose.yml
  src/
    main.rs       HTTP/WebSocket routes and app config
    session.rs    invite/session state machine
    protocol.rs   wire message types
    landing.rs    /join/<invite> browser landing page
```

## Local Rust Run

Use this for development without Docker:

```powershell
cd easycris-remote-signaling
# Same-machine local smoke values. Replace these with a LAN host name/IP if a
# desktop client on another machine must open generated invite links.
$env:PUBLIC_BASE_URL = "http://127.0.0.1:8080"
$env:RELAY_URL = "ws://127.0.0.1:8080/v1/remote/signaling"
$env:REMOTE_INVITE_HMAC_KEY = "dev-hmac-key-change-me"
$env:STUN_URLS = "stun:stun.l.google.com:19302"
$env:TURN_URLS = "turn:turn.easycris.com:3478"
$env:TURN_STATIC_AUTH_SECRET = "dev-turn-secret-change-me"
$env:RUST_LOG = "easycris_remote_signaling=info"
cargo run
```

Health check:

```powershell
curl.exe -f http://127.0.0.1:8080/health
```

## Local Docker Run

Docker is for the server deployment runtime. It does not ship inside the desktop binary.

```powershell
cd easycris-remote-signaling
docker compose up -d --build
docker compose logs -f
docker compose down
```

The local compose file exposes:

```text
http://127.0.0.1:8080
ws://127.0.0.1:8080/v1/remote/signaling?invite=<invite_id>
```

The compose defaults generate same-machine invite links. That is fine when the browser and desktop client run on the Docker host. If a different machine must consume generated links, replace `PUBLIC_BASE_URL` and `RELAY_URL` with a LAN-reachable host name/IP or the production domain before starting the container.

If `docker compose` is unavailable on Windows, install or enable Docker Compose in Docker Desktop before using these commands.

## Production Deployment Shape

Target deployment for the first cloud milestone:

```text
Hetzner VPS: 178.156.223.139
Coolify project: easycris-remote
Signaling service: easycris-remote-signaling
Signaling domain: remote.easycris.com
TURN service: easycris-turn
TURN domain: turn.easycris.com
```

Keep this service separate from the existing easyCris web app, Postgres, and Postal resources. The service owns both `/v1/remote/*` APIs and `/join/*` landing pages on `remote.easycris.com`.

### DNS Before Deploy

Create DNS records before starting the Coolify service so ACME certificate issuance can succeed:

```text
A  remote.easycris.com  178.156.223.139
A  turn.easycris.com    178.156.223.139
```

For TURN, use DNS-only if Cloudflare is in front. TURN UDP traffic must not be proxied through Cloudflare HTTP proxying.

Check propagation:

```powershell
Resolve-DnsName remote.easycris.com
Resolve-DnsName turn.easycris.com
```

### Coolify Service

In Coolify:

1. Create project `easycris-remote`.
2. Add a Dockerfile-based application from this repo path: `easycris-remote-signaling`.
3. Set the public domain to `https://remote.easycris.com`.
4. Set the environment variables below.
5. Deploy.

Useful local CLI checks:

```powershell
& "$env:LOCALAPPDATA\Coolify\coolify.exe" context verify
& "$env:LOCALAPPDATA\Coolify\coolify.exe" app list --format=pretty
```

After Coolify creates the new app, replace `<REMOTE_SIGNALING_APP_UUID>`:

```powershell
& "$env:LOCALAPPDATA\Coolify\coolify.exe" deploy uuid <REMOTE_SIGNALING_APP_UUID>
& "$env:LOCALAPPDATA\Coolify\coolify.exe" app logs <REMOTE_SIGNALING_APP_UUID> --follow
```

Server-side container check:

```powershell
ssh -i "$env:USERPROFILE\.ssh\easycris_prod_ed25519" root@178.156.223.139 "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -Ei 'easycris-remote|signaling|turn|coturn'"
```

## Environment

| Variable                      |                                   Default | Production value                                                              |
| ----------------------------- | ----------------------------------------: | ----------------------------------------------------------------------------- |
| `EASYCRIS_REMOTE_BIND`        |                            `0.0.0.0:8080` | `0.0.0.0:8080`                                                                |
| `EASYCRIS_REMOTE_ENV`         |                                     empty | `production`                                                                  |
| `PUBLIC_BASE_URL`             |                   `http://127.0.0.1:8080` | `https://remote.easycris.com`                                                 |
| `RELAY_URL`                   | `ws://127.0.0.1:8080/v1/remote/signaling` | `wss://remote.easycris.com/v1/remote/signaling`                               |
| `REMOTE_INVITE_HMAC_KEY`      |                    required in production | hex/base64 encoded 32+ random bytes, stored as a Coolify secret              |
| `INVITE_TTL_SECS`             |                                     `900` | `900`                                                                         |
| `TURN_CREDENTIAL_TTL_SECS`    |                                    `3600` | `3600`                                                                        |
| `STUN_URLS`                   |            `stun:stun.l.google.com:19302` | comma-separated STUN URLs                                                     |
| `TURN_URLS`                   |                                     empty | `turn:turn.easycris.com:3478` and optionally `turns:turn.easycris.com:5349`   |
| `TURN_STATIC_AUTH_SECRET`     |                                     empty | coturn `static-auth-secret`, stored as a Coolify secret                       |
| `INVITE_RATE_LIMIT_PER_HOUR`  |                                      `20` | tune after production telemetry                                               |
| `MAX_SIGNALING_MESSAGE_BYTES` |                                  `262144` | maximum size in bytes for one WebSocket signaling text frame, default 256 KiB |
| `SIGNALING_OUTBOUND_QUEUE_CAPACITY` |                               `64` | bounded outbound queue per WebSocket connection                               |
| `SIGNALING_MESSAGE_RATE_LIMIT` |                                    `120` | max text signaling messages per connection per rate window; `0` rejects all signaling |
| `SIGNALING_MESSAGE_RATE_WINDOW_SECS` |                              `10` | WebSocket message rate-limit window                                           |
| `SIGNALING_IDLE_TIMEOUT_SECS` |                                      `90` | idle WebSocket timeout                                                        |
| `CRITICAL_SIGNALING_SEND_TIMEOUT_MS` |                              `500` | max wait for one-off revoke/disconnect notices when a peer queue is full      |
| `SESSION_PRUNE_INTERVAL_SECS` |                                     `300` | background cleanup interval for expired/revoked invites and rate buckets      |
| `TRUSTED_PROXY_DEPTH`         |                                       `0` | number of trusted reverse-proxy hops used when reading `X-Forwarded-For`      |
| `METRICS_BEARER_TOKEN`        |                                     empty | optional bearer token required to enable `GET /v1/remote/metrics`             |

Set `EASYCRIS_REMOTE_ENV=production` in deployed environments. In production mode, `REMOTE_INVITE_HMAC_KEY` is required, must be hex/base64 encoded, must decode to at least 32 bytes, and cannot use the development fallback values. Outside production mode, an unset HMAC key falls back to a development-only key so local startup does not fail.

`REMOTE_INVITE_HMAC_KEY` and `TURN_STATIC_AUTH_SECRET` must be different values. `TURN_URLS` and `TURN_STATIC_AUTH_SECRET` are paired: set both for TURN, or leave both empty for STUN-only local development. If `TURN_URLS` is set without a static auth secret, or the secret is set without TURN URLs, startup fails. In production, the TURN secret must provide at least 32 bytes of key material; hex/base64-encoded values are decoded for validation, and raw coturn-compatible strings are accepted when they do not look encoded.

When running behind Coolify/Traefik or another trusted reverse proxy, set `TRUSTED_PROXY_DEPTH` to the number of trusted proxy hops so invite rate limiting keys on the client IP from `X-Forwarded-For`. Leave it at `0` unless the proxy path is known; untrusted forwarded headers are ignored by default.

Generate example secrets locally:

```powershell
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Do not print production secrets into logs, commits, screenshots, or chat.

## API Smoke Syntax

Set a base URL:

```powershell
$base = "http://127.0.0.1:8080"
# production:
# $base = "https://remote.easycris.com"
```

Health:

```powershell
curl.exe -f "$base/health"
```

Create invite:

```powershell
$invite = curl.exe -s -X POST "$base/v1/remote/invites" `
  -H "Content-Type: application/json" `
  -d "{}" | ConvertFrom-Json

$invite.invite_id
$invite.share_url
```

`share_url` contains the guest bearer token in its URL fragment. Treat it as a secret: do not paste it into logs, support tickets, screenshots, issue trackers, or chat.

Public metadata:

```powershell
curl.exe -s "$base/v1/remote/invites/$($invite.invite_id)"
```

ICE config as host:

```powershell
$body = @{
  role = "host"
  invite_id = $invite.invite_id
  host_secret = $invite.host_secret
} | ConvertTo-Json -Compress

curl.exe -s -X POST "$base/v1/remote/ice-config" `
  -H "Content-Type: application/json" `
  -d $body
```

Invite landing page:

```powershell
curl.exe -I "$base/join/$($invite.invite_id)"
```

WebSocket endpoint:

```text
wss://remote.easycris.com/v1/remote/signaling?invite=<invite_id>
ws://127.0.0.1:8080/v1/remote/signaling?invite=<invite_id>
```

The WebSocket route rejects missing, malformed, expired, revoked, or unknown invite IDs before upgrade.

Invite IDs are generated as `rmt_` plus 128 bits of base64url entropy. The server rejects values that do not match the `rmt_` prefix plus at least 22 URL-safe base64 characters before any invite lookup.

## Signaling Message Sequence

Expected cloud mode sequence:

```text
host -> POST /v1/remote/invites
host -> WebSocket host_register { invite_id, host_secret }
guest -> /join/<invite_id>#token=<guest_token>
guest -> easycris-remote://join?mode=cloud&invite=<invite_id>&token=<guest_token>
guest -> WebSocket join_request { invite_id, token, guest_device_id, guest_display_name }
host -> join_approved or join_rejected
host -> video_offer
guest -> video_answer
host/guest -> ice_candidate
host -> session_revoked when stopping
```

Only the approved host and approved guest can exchange SDP/ICE. Unbound heartbeat messages are rejected and the socket is closed.

### Observability

The service exposes a JSON metrics snapshot:

```powershell
curl.exe -s "$base/v1/remote/metrics" -H "Authorization: Bearer <METRICS_BEARER_TOKEN>"
```

The endpoint returns `404` when `METRICS_BEARER_TOKEN` is unset and `401` when
the bearer token is missing or wrong. The response includes active invites,
active host/guest sockets, pending guests, approved sessions, expired/revoked
invites, duplicate-guest rejections, signaling parse rejections, signaling
dispatch rejections, guest forward failures, oversize message rejections,
heartbeat messages, session-revoked messages, ICE-config rejections, and TURN
credential grants.
`heartbeat_messages` and `session_revoked_messages` increment only after
successful dispatch; failed attempts are counted in `signaling_dispatch_rejections`.
`duplicate_guest_rejections` is a subset of `signaling_dispatch_rejections`, so
do not sum those two fields as independent rejection totals.
`guest_forward_failures` is also a subset of `signaling_dispatch_rejections`; it
tracks valid host messages that could not be forwarded because the approved
guest socket was gone. These counters intentionally do not include invite
tokens, host secrets, SDP payloads, ICE payloads, or screen/input data.

## TURN Notes

The signaling service only generates temporary TURN credentials. It is not the TURN relay itself.

Run coturn as a separate service named `easycris-turn`. easyCris uses a deliberately small relay range by default; this is a permanent product policy for the current 1:1 remote-session workload, not just a staging setting. Do not deploy the generic full coturn range (`49152-65535/udp`) on the shared easyCris VPS.

```text
use-auth-secret
static-auth-secret=<same value as TURN_STATIC_AUTH_SECRET in signaling service>
realm=turn.easycris.com
external-ip=<VPS_PUBLIC_IP>
listening-port=3478
min-port=50000
max-port=50050
no-multicast-peers
no-software-attribute
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

Expose at least:

```text
3478/tcp
3478/udp
50000-50050/udp
```

Do not rely on Traefik HTTP routing for TURN UDP. The coturn ports must be exposed directly. `external-ip` is required when coturn runs inside Docker so external peers receive the VPS public IP, not a Docker bridge address. Do not add `allow-loopback-peers`; loopback peers are disallowed by default in the pinned coturn image.

Warning: publishing `49152-65535/udp` through Docker/Coolify on the shared VPS can create tens of thousands of netfilter rules and destabilize every co-located service. The generic `49152-65535/udp` range is dedicated-VPS-only for easyCris. If relay allocation failures ever prove that `50000-50050/udp` is too small, move coturn to a dedicated VPS first and expand only with metrics.

## Security Notes

- The service stores HMAC-SHA256 digests of `guest_token` and `host_secret`, not raw secrets.
- Digests are compared using constant-time comparison.
- Raw secrets are returned only once from `POST /v1/remote/invites`.
- `share_url` embeds the guest token in the fragment. Anyone with the full URL can request to join until the invite expires or is revoked.
- Do not log full invite tokens or host secrets.
- `/join/*` keeps the guest token in the browser fragment and translates it to `easycris-remote://join?...&token=...` locally.
- `POST /v1/remote/ice-config` requires host or guest proof before returning TURN credentials.
- `REMOTE_INVITE_HMAC_KEY` rotation invalidates active invites.

## Rollback

For a Coolify deployment, prefer rolling back the `easycris-remote-signaling` resource only. Do not touch the existing `easycris_web`, Postgres, or Postal resources.

Useful commands:

```powershell
& "$env:LOCALAPPDATA\Coolify\coolify.exe" app deployments list <REMOTE_SIGNALING_APP_UUID>
& "$env:LOCALAPPDATA\Coolify\coolify.exe" app logs <REMOTE_SIGNALING_APP_UUID> --follow
```

If the new deploy breaks health checks:

1. Roll back to the previous successful deployment in the Coolify UI for `easycris-remote-signaling`.
2. Confirm `https://remote.easycris.com/health` returns `200`.
3. Check that `easycris-remote-signaling` is the only remote service changed.
4. If DNS or TLS is the problem, remove only the `remote.easycris.com` domain from this resource or restore the previous DNS record.
5. Existing invites are in-memory for the spike; assume rollback/restart invalidates active invites and ask hosts to create new ones.

Local Docker rollback:

```powershell
cd easycris-remote-signaling
docker compose down
git checkout -- easycris-remote-signaling
docker compose up -d --build
```

## Verification

Run these checks before committing changes to this service:

```powershell
cd easycris-remote-signaling
cargo fmt --check
cargo clippy -- -D warnings
cargo test
cargo build --release
```

From the repo root, also run:

```powershell
npm run -s typecheck
npm run -s isolation:allowlist:check
npm run -s license:summary:check
git diff --check
```

If code changed, rebuild the Graphify map from the repo root:

```powershell
npm run graphify:rebuild
```

## Troubleshooting

| Symptom                                            | Check                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `remote.easycris.com` has no certificate           | Confirm DNS A record exists before Coolify deploy and points to `178.156.223.139`                            |
| WebSocket returns `400` before upgrade             | Invite query is missing, malformed, or does not match the `rmt_...` shape                                    |
| WebSocket returns `404` before upgrade             | Invite is unknown, expired, or revoked                                                                       |
| ICE endpoint returns unauthorized                  | Use the one-time `host_secret` for host role or `guest_token` for guest role                                 |
| TURN credentials returned but relay fails          | Verify coturn `static-auth-secret` matches `TURN_STATIC_AUTH_SECRET`, UDP range is open, and DNS is DNS-only |
| Generated invite points at localhost unexpectedly  | Set `PUBLIC_BASE_URL` and `RELAY_URL` for the environment before creating invites                            |
| Docker build works but desktop app does not change | Expected. This service is server-side only; desktop client changes live outside this folder                  |
