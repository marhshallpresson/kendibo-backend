#!/bin/sh
# Deploy the committed HEAD of kendibo-backend to LiteHost (api.kendibo.ng).
#   sh scripts/deploy-litehost.sh
# Uploads `git archive HEAD`, builds it in ~/apps/kendibo-api/releases/<sha>,
# applies migrations, switches `current`, restarts the panel worker (it restarts
# itself when its process exits), checks /health/ready and rolls back if it fails.
# Settings live on the server in ~/shared/kendibo-api/.env (never uploaded).
set -eu
HOST="${LITEHOST_HOST:-appuser@203.0.113.10}"
KEY="${LITEHOST_KEY:-$HOME/.ssh/deploy_key}"
APP=kendibo-api
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=10"
SCP="scp -q -i $KEY -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=10"

[ -z "$(git status --porcelain --untracked-files=no -- apps modules packages scripts infra package.json package-lock.json)" ] \
  || { echo "Commit your changes first: only committed code is deployed." >&2; exit 1; }
SHA="$(git rev-parse --short HEAD)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git archive --format=tar.gz -o "$TMP/$APP-$SHA.tgz" HEAD
SIZE="$(wc -c < "$TMP/$APP-$SHA.tgz" | tr -d ' ')"

# Flaky links happen: retry the upload until the server has every byte.
for i in 1 2 3 4 5; do
  $SCP "$TMP/$APP-$SHA.tgz" "$HOST:backups/kendibo/" || true
  GOT="$($SSH "$HOST" "stat -c %s ~/backups/kendibo/$APP-$SHA.tgz" 2>/dev/null || echo 0)"
  [ "$GOT" = "$SIZE" ] && break
  [ "$i" = 5 ] && { echo "Upload failed ($GOT of $SIZE bytes)." >&2; exit 1; }
  sleep 5
done
echo "Uploaded $APP $SHA ($SIZE bytes)"

$SSH "$HOST" APP="$APP" SHA="$SHA" sh -s <<'REMOTE'
set -eu
ROOT="$HOME/apps/$APP"; R="$ROOT/releases/$SHA"; PREV="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
rm -rf "$R"; mkdir -p "$R"; tar xzf "$HOME/backups/kendibo/$APP-$SHA.tgz" -C "$R"
ln -sfn "$HOME/shared/$APP/.env" "$R/.env"
. "$HOME/.nvm/nvm.sh" >/dev/null; nvm use 24 >/dev/null
cd "$R"
export UV_THREADPOOL_SIZE=2 NODE_OPTIONS=--max-old-space-size=2048
npm ci --include=dev --no-audit --no-fund >/dev/null
npm run build >/dev/null
[ -f dist/apps/api/src/main.js ] || { echo "Build failed; $PREV keeps running." >&2; exit 1; }
node scripts/migrate.js | grep -E "OK|FAILED|tables present"

restart() {
  # Stop the process running from this app; the panel worker starts it again on `current`.
  for pid in $(pgrep -u "$(id -u)" -f "node" || true); do
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    case "$cwd" in "$ROOT"/*) kill "$pid" 2>/dev/null || true ;; esac
  done
}
healthy() {
  for i in $(seq 1 30); do
    curl -fsS -m 5 http://127.0.0.1:4030/health/ready >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
ln -sfn "$R" "$ROOT/current"; restart
if healthy; then
  echo "Live: $APP $SHA"
  ls -1dt "$ROOT"/releases/* | tail -n +6 | xargs -r rm -rf   # keep the last 5 releases
else
  echo "Health check failed; rolling back to $PREV" >&2
  [ -n "$PREV" ] && ln -sfn "$PREV" "$ROOT/current" && restart
  exit 1
fi
REMOTE
