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

DIRTY="$(git status --porcelain --untracked-files=no -- apps modules packages scripts infra package.json package-lock.json)"
[ -z "$DIRTY" ] || printf 'Note: these uncommitted changes are NOT deployed (only HEAD is):\n%s\n' "$DIRTY" >&2
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

$SSH "$HOST" APP="$APP" SHA="$SHA" BASELINE="${LITEHOST_MIGRATE_BASELINE:-}" sh -s <<'REMOTE'
set -eu
ROOT="$HOME/apps/$APP"; R="$ROOT/releases/$SHA"; PREV="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
rm -rf "$R"; mkdir -p "$R"; tar xzf "$HOME/backups/kendibo/$APP-$SHA.tgz" -C "$R"
ln -sfn "$HOME/shared/$APP/.env" "$R/.env"
. "$HOME/.nvm/nvm.sh" >/dev/null; nvm use 24 >/dev/null
cd "$R"
export UV_THREADPOOL_SIZE=2 NODE_OPTIONS=--max-old-space-size=2048
# The container caps threads. Same lockfile as the running release: reuse its
# packages as hard links (instant, no extra disk). Otherwise install, running
# package install scripts one at a time so they don't exhaust threads.
if [ -n "$PREV" ] && [ -d "$PREV/node_modules" ] && cmp -s "$PREV/package-lock.json" package-lock.json; then
  cp -al "$PREV/node_modules" node_modules
  echo "Packages unchanged: reused from $(basename "$PREV")"
else
  npm_config_foreground_scripts=true npm ci --include=dev --no-audit --no-fund >/dev/null
fi
npm run build >/dev/null
[ -f dist/apps/api/src/main.js ] || { echo "Build failed; $PREV keeps running." >&2; exit 1; }
# Tracked migrations: only files not yet recorded for this database run. A
# failure (or an untracked database) stops the deploy; the old release stays up.
# One-time baseline for a database that predates tracking:
#   LITEHOST_MIGRATE_BASELINE=049 sh scripts/deploy-litehost.sh
if ! MIGRATE_BASELINE_THROUGH="$BASELINE" node scripts/migrate.js > .migrate.log 2>&1; then
  grep -v "MODULE_TYPELESS\|Reparsing\|eliminate this\|trace-warnings" .migrate.log | tail -6 >&2
  echo "Migration did not run cleanly; $PREV keeps running." >&2
  exit 1
fi
grep -E "^\[migrate\] (applied|baselined|nothing|note|tables present|OK)" .migrate.log | tail -12

app_pids() {
  # Node renames its process ("MainThread"), so match the command line, then the folder.
  for pid in $(pgrep -u "$(id -u)" -f "dist/apps/api/src/main.js" || true); do
    [ "$pid" = "$$" ] && continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    case "$cwd" in "$ROOT"/*) echo "$pid" ;; esac
  done
}
restart() {
  # Stop the running process; the panel worker starts it again on `current`.
  OLD="$(app_pids)"
  [ -n "$OLD" ] && kill $OLD 2>/dev/null || true
  for i in $(seq 1 15); do
    alive=""; for p in $OLD; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
    [ -z "$alive" ] && return 0
    sleep 1
  done
  echo "Old process did not stop in 15s; forcing it." >&2
  kill -9 $alive 2>/dev/null || true
}
healthy() {
  # Healthy = the process serving is the new release AND it answers /health/ready.
  want="$(readlink -f "$ROOT/current")"
  for i in $(seq 1 45); do
    for p in $(app_pids); do
      if [ "$(readlink -f "/proc/$p/cwd")" = "$want" ] && curl -fsS -m 5 http://127.0.0.1:4030/health/ready >/dev/null 2>&1; then return 0; fi
    done
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
