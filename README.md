# Live Agent

A local multimodal assistant with a meeting-style interface, camera and screen context, voice replies, and supervised tools. Built as a portfolio project; experimental and intended for one user on localhost.

## Features

- Independent microphone, camera, and screen-sharing controls.
- Separate final spoken replies and visible tool activity.
- Web search and page reading; browser actions require individual approval.
- Task checklist with pause, resume, and cancel.
- Optional selected-folder text-file tools and reviewed Markdown note writes.
- Optional editable memory, export, and deletion. Memory starts disabled.

## Run locally

Requires Python 3.11+, Node.js 20+, a compatible llama.cpp build supporting LFM3 Omni, and the LiquidAI LFM3-Omni-2B GGUF model plus its matching vision projector. Model weights are downloaded separately and excluded from this repository. Apple Silicon was the development platform; performance and hardware support vary.

```sh
npm ci
npx playwright install chromium
./start-model.sh
```

In another terminal:

```sh
./start.sh
```

Open http://127.0.0.1:8765. Allow microphone/camera access when needed; select a screen or window through the browser sharing picker. On macOS the browser tool uses installed Google Chrome by default; set LIVE_AGENT_BROWSER_CHANNEL=chromium to use Playwright Chromium.

The model launcher defaults to LM Studio's LiquidAI/LFM3-Omni-2B-GGUF folder. Override MODEL_FILE, PROJECTOR_FILE, and LLAMA_BIN for another location. The backend defaults to port 8080; the UI defaults to 8765. Use `python3 server.py --help` for server options. The Python server uses the standard library.

## Development

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m unittest discover -s tests
npm run test:ui
npm run test:browser
.venv/bin/black --check .
.venv/bin/ruff check .
npm run format:check
```

CI runs these checks. Integration scripts under tests/integration require running local servers and model weights. Device permissions, microphone echo handling, and model speed require manual hardware testing.

## Limits and data

Small-model tool selection can be unreliable. Browser verification checks observable effects, not whether the user's entire goal succeeded. Only main-document targets are exposed; arbitrary desktop control is unavailable. File tools support bounded text files, not rich document parsing. Recap previews cover recent conversation turns.

Audio and visual inputs are processed in memory by this app. Enabled memory is stored in data/memory.json; browser state is temporary. Explicit note saves write into the selected folder. Web requests send search terms or page requests to outside services. See SECURITY.md for boundaries and limitations.

No license has been selected. Model and dependency licenses are separate.
