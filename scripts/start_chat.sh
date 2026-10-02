#!/usr/bin/env bash
set -euo pipefail

site_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
mwdf_root=$(dirname -- "$site_root")/mwdf
venvs=/data/students/wiwal2741/venvs
runtime_env=(/usr/bin/env HOME=/var/tmp/wiwal2741-birget-rescue MWDF_ENGINE_CACHE=/Home/siv36/wiwal2741/.cache/mwdf_engine
  PATH="$venvs/mwdf-py311/bin:/usr/local/cuda/bin:/usr/bin:/bin" PYTHONPATH=)

if ! tmux has-session -t '=chat_inference_server' 2>/dev/null; then
  tmux new-session -d -s chat_inference_server -c "$mwdf_root" \
    "${runtime_env[@]}" "$venvs/mwdf-py311/bin/python" -u \
    scripts/tools/chat_server.py --interface public \
    --checkpoint annulus-7b-exp-dpo=artifacts/dpo/annulus_7b_exp_sft_dpo_it1/checkpoint_step_141.pkl \
    --checkpoint annulus-7b-reif-dpo=artifacts/dpo/annulus_7b_reif_sft_dpo_it1/checkpoint_step_141.pkl \
    --checkpoint annulus-7b-control-dpo=artifacts/dpo/annulus_7b_control_sft_dpo_it1/checkpoint_step_140.pkl \
    --gpu 0 --port 8400 --no-tunnel
fi

if ! tmux has-session -t '=chat_gradio' 2>/dev/null; then
  tmux new-session -d -s chat_gradio -c "$site_root" \
    "${runtime_env[@]}" "$venvs/chat-gradio/bin/python" -u scripts/serve.py --share
fi

printf '%s\n' 'Sessions: chat_inference_server and chat_gradio' \
  'Inspect startup and the public URL with: tmux attach -t chat_gradio'
