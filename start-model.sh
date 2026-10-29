#!/bin/sh
set -eu
MODEL_DIR="${MODEL_DIR:-$HOME/.lmstudio/models/LiquidAI/LFM3-Omni-2B-GGUF}"
MODEL_FILE="${MODEL_FILE:-$MODEL_DIR/LFM3-Omni-2B-Q4_K_M.gguf}"
PROJECTOR_FILE="${PROJECTOR_FILE:-$MODEL_DIR/mmproj-LFM3-Omni-2B-F16.gguf}"
if [ -z "${LLAMA_BIN:-}" ]; then
  LLAMA_BIN="$(command -v llama || command -v llama-server || true)"
fi
if [ -z "$LLAMA_BIN" ] || [ ! -f "$MODEL_FILE" ] || [ ! -f "$PROJECTOR_FILE" ]; then
  echo "Set LLAMA_BIN, MODEL_FILE and PROJECTOR_FILE to an installed llama.cpp binary and compatible GGUF files." >&2
  exit 1
fi
case "$LLAMA_BIN" in
  *llama-server) set -- "$LLAMA_BIN" ;;
  *) set -- "$LLAMA_BIN" serve ;;
esac
exec "$@" -m "$MODEL_FILE" --mmproj "$PROJECTOR_FILE" --reasoning off \
  --host 127.0.0.1 --port "${MODEL_PORT:-8080}" -c "${CONTEXT_SIZE:-8192}" -np 1
