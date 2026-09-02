#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
pinned_version=$(cat "$repo_root/.node-version")
node_path=
for argument in "$@"
do
  case "$argument" in
    --url|--url=*|--token|--token=*|--discovery|--discovery=*)
      printf 'The official relay launcher does not allow gateway route overrides.\n' >&2
      exit 2
      ;;
  esac
done

for candidate in \
  "$HOME/.local/share/fnm/node-versions/v$pinned_version/installation/bin/node" \
  "$HOME/.nvm/versions/node/v$pinned_version/bin/node" \
  "$HOME/.asdf/installs/nodejs/$pinned_version/bin/node" \
  "$HOME/.volta/tools/image/node/$pinned_version/bin/node"
do
  if [ -x "$candidate" ]; then
    node_path=$candidate
    break
  fi
done

if [ -z "$node_path" ]; then
  printf 'Grok Bot requires Node %s. Install the pinned runtime before starting CLI or MCP.\n' "$pinned_version" >&2
  exit 1
fi

unset GROK_BOT_GATEWAY_URL
unset GROK_BOT_GATEWAY_TOKEN
unset GROK_BOT_GATEWAY_NETWORK_TOKEN
export GROK_BOT_GATEWAY_DISCOVERY="$HOME/.grokbot-official-relay/gateway.json"
unset SAND_HOST_GATEWAY_URL
unset SAND_HOST_GATEWAY_TOKEN
unset SAND_HOST_GATEWAY_NETWORK_TOKEN

exec "$node_path" "$repo_root/dist/cli/grok-bot.mjs" "$@"
