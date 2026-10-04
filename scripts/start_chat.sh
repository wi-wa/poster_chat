#!/usr/bin/env bash
set -euo pipefail

site_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
venvs=/data/students/wiwal2741/venvs
runtime_env=(/usr/bin/env HOME=/var/tmp/wiwal2741-birget-rescue MWDF_ENGINE_CACHE=/Home/siv36/wiwal2741/.cache/mwdf_engine
  PATH="$venvs/mwdf-py311/bin:/usr/local/cuda/bin:/usr/bin:/bin" PYTHONPATH=)

if ! tmux has-session -t '=chat_gradio' 2>/dev/null; then
  tmux new-session -d -s chat_gradio -c "$site_root" \
    "${runtime_env[@]}" "$venvs/chat-gradio/bin/python" -u scripts/serve.py --share
fi

printf '%s\n' 'Session: chat_gradio (the site, the API proxy and the chat page'"'"'s WAKE UP button)' \
  'The inference server sleeps until someone presses WAKE UP; to start it by hand: scripts/start_inference.sh [GPU]' \
  'Inspect startup and the public URL with: tmux attach -t chat_gradio'
