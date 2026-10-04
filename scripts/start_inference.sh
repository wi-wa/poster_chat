#!/usr/bin/env bash
# Start the chat inference server (the three 7B DPO models on port 8400) in tmux session
# chat_inference_server unless it is already running, writing its output to
# .gradio/inference_server.log. Usage: scripts/start_inference.sh [GPU] (default 0).
# serve.py runs this for the chat page's WAKE UP button; start_chat.sh runs it at startup.
set -euo pipefail

site_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
mwdf_root=$(dirname -- "$site_root")/mwdf
venvs=/data/students/wiwal2741/venvs
gpu=${1:-0}
log=$site_root/.gradio/inference_server.log
runtime_env=(/usr/bin/env HOME=/var/tmp/wiwal2741-birget-rescue MWDF_ENGINE_CACHE=/Home/siv36/wiwal2741/.cache/mwdf_engine
  PATH="$venvs/mwdf-py311/bin:/usr/local/cuda/bin:/usr/bin:/bin" PYTHONPATH=)

if tmux has-session -t '=chat_inference_server' 2>/dev/null; then
  echo "chat_inference_server is already running"
  exit 0
fi

mkdir -p "$(dirname -- "$log")"
printf '%s Starting the inference server on GPU %s\n' "$(date '+%H:%M:%S')" "$gpu" > "$log"
# tmux 2.7 joins command arguments into one shell string, so quote them here.
command=$(printf '%q ' "${runtime_env[@]}" "$venvs/mwdf-py311/bin/python" -u \
  scripts/tools/chat_server.py --interface public \
  --checkpoint annulus-7b-exp-dpo=artifacts/dpo/annulus_7b_exp_sft_dpo_it1/checkpoint_step_141.pkl \
  --checkpoint annulus-7b-reif-dpo=artifacts/dpo/annulus_7b_reif_sft_dpo_it1/checkpoint_step_141.pkl \
  --checkpoint annulus-7b-control-dpo=artifacts/dpo/annulus_7b_control_sft_dpo_it1/checkpoint_step_140.pkl \
  --gpu "$gpu" --port 8400 --no-tunnel)
tmux new-session -d -s chat_inference_server -c "$mwdf_root" "$command 2>&1 | tee -a $(printf '%q' "$log")"
echo "Started chat_inference_server on GPU $gpu; log: $log"
