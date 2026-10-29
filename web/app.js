import { api, chat, csrfToken, download } from "./api.js";
const $ = (id) => document.getElementById(id);
let stream,
  context,
  source,
  capture,
  silent,
  active = false,
  busy = false,
  epoch = 0;
let chunks = [],
  pre = [],
  talking = false,
  quiet = 0,
  duration = 0,
  voiced = 0;
let history = [],
  controller,
  audioURL,
  ready = false;
let screenStream = null,
  pendingApproval = null;
let cameraStream = null,
  micStarting = false,
  cameraStarting = false,
  screenStarting = false;
let currentTask = null;
let interruptSamples = [],
  interruptDuration = 0;
let noteDraft = null,
  memoryData = { enabled: false, preferences: "", facts: [], summaries: [] };
const status = (text) => {
  $("status").textContent = text;
  const mode = /Speaking/.test(text)
    ? "speaking"
    : /Listening/.test(text)
      ? "listening"
      : /approval/.test(text)
        ? "approval"
        : /Thinking|Searching|Reading|Preparing|Generating|Hearing|Using/.test(
              text,
            )
          ? "thinking"
          : "idle";
  $("agentTile").dataset.state = mode;
  $("interruptReply").hidden = mode !== "speaking";
  $("agentState").textContent = {
    speaking: "Speaking",
    listening: "Listening",
    thinking: "Working on it",
    approval: "Your approval needed",
    idle: ready ? "Ready when you are" : "Connecting",
  }[mode];
};
const log = (who, text) => {
  $("chatEmpty").hidden = true;
  const p = document.createElement("div");
  p.className =
    "message " +
    (who === "You" ? "you" : who === "Agent" ? "agent" : "activity");
  const name = document.createElement("span"),
    body = document.createElement("p");
  name.textContent = who;
  body.textContent = text;
  p.append(name, body);
  $("log").append(p);
  $("log").parentElement.scrollTop = $("log").parentElement.scrollHeight;
};
function resetVAD() {
  chunks = [];
  pre = [];
  talking = false;
  quiet = 0;
  duration = 0;
  voiced = 0;
}
function buttons() {
  $("toggleMic").disabled = micStarting || !ready;
  $("toggleCamera").disabled = cameraStarting;
  $("toggleScreen").disabled = screenStarting;
  for (const [id, on, label] of [
    ["toggleMic", active, "microphone"],
    ["toggleCamera", !!cameraStream, "camera"],
    ["toggleScreen", !!screenStream, "screen sharing"],
  ]) {
    $(id).classList.toggle("enabled", on);
    $(id).classList.toggle("device-off", !on && id !== "toggleScreen");
    $(id).setAttribute("aria-pressed", String(on));
    $(id).setAttribute("aria-label", `${on ? "Turn off" : "Turn on"} ${label}`);
    $(id).title = `${on ? "Turn off" : "Turn on"} ${label}`;
  }
  $("selfTile").classList.toggle("camera-on", !!cameraStream);
  $("selfMic").textContent = active ? "Mic on" : "Mic off";
  $("sharingBadge").hidden = !screenStream;
  $("stop").disabled =
    !active &&
    !cameraStream &&
    !busy &&
    !screenStream &&
    !micStarting &&
    !cameraStarting &&
    !screenStarting;
  $("send").disabled = !ready || busy;
}
async function agent(messages, signal, ticket) {
  currentTask = {
    id: crypto.randomUUID(),
    status: "working",
    goal: "",
    steps: [],
  };
  renderTask(currentTask);
  const response = await api(
    "/api/agent",
    {
      messages,
      web: $("web").checked,
      browser: $("browserEnabled").checked,
      files: $("filesEnabled").checked,
      task_id: currentTask.id,
    },
    signal,
  );
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    answer;
  const event = (line) => {
    if (!line.trim() || ticket !== epoch) return;
    const e = JSON.parse(line);
    if (e.type === "task_state") {
      currentTask = e.task;
      renderTask(e.task);
    }
    if (e.type === "note_draft") showNoteDraft(e.draft);
    if (e.type === "action_progress")
      log(
        "Browser · " + e.phase,
        e.detail || e.action.reason || e.action.action,
      );
    if (e.type === "browser_state") showBrowser(e.state);
    if (e.type === "approval_required") {
      setChat(true);
      pendingApproval = e.id;
      $("approval").hidden = false;
      $("approve").disabled = false;
      $("reject").disabled = false;
      $("proposal").textContent =
        `Page: ${e.url}\nAction: ${e.action.action}\nTarget: ${e.target?.label || e.action.value || "(navigation)"}\nText/key/URL: ${e.action.value || ""}\nReason: ${e.action.reason || ""}\nExpires in at most 60 seconds. Approve only this action.`;
      showBrowser({ screenshot: e.screenshot });
      status("Waiting for your approval — no browser action has run.");
      log("Approval requested", JSON.stringify(e.action));
    }
    if (e.type === "tool_start") {
      status(
        {
          web_search: "Searching the web…",
          read_page: "Reading a webpage…",
          browser_observe: "Looking at the browser…",
          browser_action: "Preparing a browser action…",
        }[e.name] || "Working…",
      );
      log("Tool", `${e.name}: ${JSON.stringify(e.arguments)}`);
    }
    if (e.type === "tool_result") {
      if (e.name === "browser_action") {
        pendingApproval = null;
        $("approval").hidden = true;
      }
      const details = document.createElement("details"),
        summary = document.createElement("summary"),
        pre = document.createElement("pre");
      details.className = "tool-result";
      $("chatEmpty").hidden = true;
      summary.textContent = `${e.name}: ${e.result.error ? "failed" : "complete"}`;
      pre.textContent = JSON.stringify(e.result, null, 2);
      pre.style.whiteSpace = "pre-wrap";
      pre.style.overflowWrap = "anywhere";
      details.append(summary, pre);
      $("log").append(details);
    }
    if (e.type === "status") status(e.text);
    if (e.type === "error") throw Error(e.message);
    if (e.type === "answer") {
      answer = { text: e.text, speech: e.speech };
      $("sources").replaceChildren();
      for (const s of e.sources || []) {
        try {
          const url = new URL(s.url);
          if (url.protocol !== "https:") continue;
          const link = document.createElement("a");
          link.href = url.href;
          link.textContent = `[${s.id}] ${s.title}`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.style.display = "block";
          $("sources").append(link);
        } catch {}
      }
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        event(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!answer) throw Error("Agent returned no answer.");
  return answer;
}
function visualFrames() {
  if (!$("vision").checked) return [];
  const selected = $("visualSource").value,
    frames = [];
  for (const [name, enabled, video, width] of [
    ["Camera", !!cameraStream, $("camera"), 320],
    ["Shared screen", !!screenStream, $("screenPreview"), 768],
  ]) {
    if (!enabled || !video.videoWidth) continue;
    if (
      (selected === "camera" && name !== "Camera") ||
      (selected === "screen" && name !== "Shared screen")
    )
      continue;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * width);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push({ name, url: canvas.toDataURL("image/jpeg", 0.7) });
  }
  return frames;
}
function wavBase64(parts, rate) {
  const length = parts.reduce((n, p) => n + p.length, 0),
    samples = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    samples.set(part, offset);
    offset += part.length;
  }
  const ratio = rate / 16000,
    count = Math.floor(length / ratio),
    buffer = new ArrayBuffer(44 + count * 2),
    view = new DataView(buffer);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    let sum = 0,
      n = 0;
    for (
      let j = Math.floor(i * ratio);
      j < Math.min(length, Math.floor((i + 1) * ratio));
      j++
    ) {
      sum += samples[j];
      n++;
    }
    const v = Math.max(-1, Math.min(1, sum / (n || 1)));
    view.setInt16(44 + i * 2, v * (v < 0 ? 32768 : 32767), true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function onSamples(samples) {
  if (!active) return;
  const seconds = samples.length / context.sampleRate;
  const rms = Math.sqrt(
    samples.reduce((sum, v) => sum + v * v, 0) / samples.length,
  );
  $("level").value = rms;
  if (busy) {
    if (
      $("bargeIn").checked &&
      $("agentTile").dataset.state === "speaking" &&
      rms > Number($("threshold").value) * 2
    ) {
      interruptSamples.push(samples);
      interruptDuration += seconds;
      if (interruptDuration >= 0.35) {
        const buffered = interruptSamples.slice();
        interruptReply();
        talking = true;
        chunks = buffered;
        voiced = 0.35;
        duration = 0.35;
      }
    } else {
      interruptSamples = [];
      interruptDuration = 0;
    }
    return;
  }
  const speech = rms > Number($("threshold").value);
  if (!talking) {
    pre.push(samples);
    if (pre.length > 5) pre.shift();
    if (!speech) return;
    talking = true;
    chunks = pre.slice();
    pre = [];
    status("Listening — speak, then pause.");
  } else chunks.push(samples);
  duration += seconds;
  if (speech) {
    quiet = 0;
    voiced += seconds;
  } else quiet += seconds;
  if (quiet >= 0.9 || duration >= 12) {
    const parts = chunks.slice(),
      rate = context.sampleRate,
      valid = voiced >= 0.25;
    resetVAD();
    if (valid) void turn("", wavBase64(parts, rate));
  }
}
async function play(blob, signal) {
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = URL.createObjectURL(blob);
  const player = $("reply");
  player.src = audioURL;
  await new Promise((resolve, reject) => {
    const clean = () => {
      player.onended = null;
      player.onerror = null;
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      player.pause();
      clean();
      reject(new DOMException("Stopped", "AbortError"));
    };
    player.onended = () => {
      clean();
      resolve();
    };
    player.onerror = () => {
      clean();
      reject(Error("Cannot play the speech WAV."));
    };
    signal.addEventListener("abort", abort, { once: true });
    player.play().catch((e) => {
      clean();
      reject(e);
    });
  });
}
async function turn(text, audio = null) {
  if (!ready || busy) return;
  busy = true;
  buttons();
  resetVAD();
  const ticket = epoch;
  controller = new AbortController();
  const signal = controller.signal;
  const start = performance.now();
  try {
    const images = visualFrames();
    if (audio) {
      status("Hearing your question…");
      text = await chat(
        [
          { role: "system", content: "Perform ASR in English." },
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: audio, format: "wav" },
              },
            ],
          },
        ],
        signal,
        256,
      );
    }
    if (ticket !== epoch) return;
    log("You", text);
    status("Thinking about what I see and hear…");
    const content = [];
    for (const image of images)
      content.push(
        { type: "text", text: `Visual source: ${image.name}.` },
        { type: "image_url", image_url: { url: image.url } },
      );
    content.push({ type: "text", text });
    // Keep original audio too, so the answer can use sounds beyond the transcript.
    if (audio)
      content.push({
        type: "input_audio",
        input_audio: { data: audio, format: "wav" },
      });
    const final = await agent(
      [...history, { role: "user", content }],
      signal,
      ticket,
    );
    const answer = final.text;
    if (ticket !== epoch) return;
    log("Agent", answer);
    history.push(
      { role: "user", content: text.slice(0, 600) },
      { role: "assistant", content: answer.slice(0, 800) },
    );
    history = history.slice(-4);
    $("timing").textContent =
      `Answer ready in ${((performance.now() - start) / 1000).toFixed(1)}s`;
    status("Generating spoken reply…");
    if (!final.speech?.trim()) return;
    const r = await api(
      "/api/tts",
      {
        input: final.speech,
        lang: "en",
        voice: $("voice").value,
        n_predict: 512,
      },
      signal,
    );
    const blob = await r.blob();
    if (ticket !== epoch) return;
    status("Speaking…");
    await play(blob, signal);
  } catch (error) {
    if (error.name !== "AbortError" && ticket === epoch) {
      log("Error", error.message);
      status("Turn failed. See the error below; listening will resume.");
    }
  } finally {
    if (ticket === epoch) {
      busy = false;
      pendingApproval = null;
      $("approval").hidden = true;
      resetVAD();
      buttons();
      status(
        active
          ? "Listening — ask a question, then pause."
          : "Ready — type a question or start camera and microphone.",
      );
    }
  }
}
async function stop() {
  if (currentTask && ["working", "paused"].includes(currentTask.status))
    void api("/api/task/cancel", { id: currentTask.id }).catch(() => {});
  pendingApproval = null;
  $("approval").hidden = true;
  void api("/api/browser/cancel", {}).catch(() => {});
  stopSharing();
  epoch++;
  controller?.abort();
  $("reply").pause();
  await stopMic();
  stopCamera();
  busy = false;
  resetVAD();
  $("level").value = 0;
  buttons();
  status(
    "Session paused. Your microphone, camera, and screen sharing are off.",
  );
}
async function stopMic() {
  active = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  capture?.disconnect();
  source?.disconnect();
  silent?.disconnect();
  await context?.close().catch(() => {});
  context = null;
  source = null;
  capture = null;
  silent = null;
  resetVAD();
  $("level").value = 0;
  buttons();
}
function stopCamera() {
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  $("camera").srcObject = null;
  buttons();
}
$("toggleMic").onclick = async () => {
  if (active) {
    await stopMic();
    if (!busy) status("Microphone off. You can still type in chat.");
    return;
  }
  micStarting = true;
  buttons();
  const ticket = epoch;
  try {
    status("Requesting microphone…");
    const acquired = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (ticket !== epoch) {
      acquired.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = acquired;
    context = new AudioContext();
    await context.audioWorklet.addModule("/capture.js");
    await context.resume();
    if (ticket !== epoch) {
      await stopMic();
      return;
    }
    source = context.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(context, "capture");
    silent = context.createGain();
    silent.gain.value = 0;
    capture.port.onmessage = (e) => onSamples(e.data);
    source.connect(capture).connect(silent).connect(context.destination);
    active = true;
    stream.getAudioTracks()[0].onended = () => void stopMic();
    status("Listening — ask a question, then pause.");
  } catch (error) {
    await stopMic();
    log("Microphone", error.message);
    status("Could not enable microphone. Check browser permissions.");
  } finally {
    micStarting = false;
    buttons();
  }
};
$("toggleCamera").onclick = async () => {
  if (cameraStream) {
    stopCamera();
    return;
  }
  cameraStarting = true;
  buttons();
  const ticket = epoch;
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
    });
    if (ticket !== epoch) {
      acquired.getTracks().forEach((t) => t.stop());
      return;
    }
    cameraStream = acquired;
    $("camera").srcObject = cameraStream;
    await $("camera").play();
    cameraStream.getVideoTracks()[0].onended = stopCamera;
  } catch (e) {
    stopCamera();
    log("Camera", e.message);
  } finally {
    cameraStarting = false;
    buttons();
  }
};
$("stop").onclick = stop;
$("form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("question").value.trim();
  if (text && ready && !busy) {
    $("question").value = "";
    void turn(text);
  }
};
$("clear").onclick = () => {
  if (busy) {
    log("System", "Stop the current turn before clearing.");
    return;
  }
  history = [];
  $("log").replaceChildren();
  $("sources").replaceChildren();
  $("chatEmpty").hidden = false;
};
$("threshold").oninput = () => {
  $("thresholdValue").textContent = $("threshold").value;
};
window.addEventListener("beforeunload", () => {
  controller?.abort();
  stream?.getTracks().forEach((t) => t.stop());
  cameraStream?.getTracks().forEach((t) => t.stop());
});
function stopSharing() {
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  $("screenPreview").srcObject = null;
  $("screenPreview").hidden = true;
  $("screenTile").hidden = true;
  $("visualSource").value = "camera";
  buttons();
}
function showBrowser(state) {
  if (state.screenshot) {
    $("browserPreview").src = "data:image/jpeg;base64," + state.screenshot;
    $("browserPreview").hidden = false;
    $("approvalPreview").src = $("browserPreview").src;
  }
}
$("toggleScreen").onclick = async () => {
  if (screenStream) {
    stopSharing();
    return;
  }
  screenStarting = true;
  buttons();
  const ticket = epoch;
  try {
    if (!navigator.mediaDevices?.getDisplayMedia)
      throw Error(
        "Screen sharing is unavailable in this browser. Open this app in Chrome or Edge.",
      );
    const acquired = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    if (ticket !== epoch) {
      acquired.getTracks().forEach((t) => t.stop());
      return;
    }
    screenStream = acquired;
    $("screenPreview").srcObject = screenStream;
    $("screenPreview").hidden = false;
    $("screenTile").hidden = false;
    await $("screenPreview").play();
    screenStream.getVideoTracks()[0].onended = stopSharing;
    $("visualSource").value = "both";
    log(
      "Screen",
      "Sharing enabled. Questions include labeled camera and screen snapshots when both are on.",
    );
  } catch (e) {
    stopSharing();
    log("Screen", e.message);
  } finally {
    screenStarting = false;
    buttons();
  }
};
$("openBrowser").onclick = async () => {
  try {
    $("openBrowser").disabled = true;
    const r = await api("/api/browser/open", { url: $("browserURL").value });
    showBrowser(await r.json());
    $("browserEnabled").checked = true;
    log(
      "Browser",
      "Dedicated browser opened. Ask for a task; each action requires approval.",
    );
  } catch (e) {
    log("Browser error", e.message);
  } finally {
    $("openBrowser").disabled = false;
  }
};
$("closeBrowser").onclick = async () => {
  try {
    await api("/api/browser/close", {});
    $("browserEnabled").checked = false;
    $("browserPreview").hidden = true;
    $("approval").hidden = true;
    pendingApproval = null;
    log("Browser", "Closed; pending actions cancelled.");
  } catch (e) {
    log("Browser error", e.message);
  }
};
async function decide(approved) {
  if (!pendingApproval) return;
  const id = pendingApproval;
  pendingApproval = null;
  $("approve").disabled = true;
  $("reject").disabled = true;
  try {
    await api("/api/browser/approve", { id, approved });
    $("approval").hidden = true;
    log("Browser", approved ? "Approved one action." : "Rejected action.");
  } catch (e) {
    $("approval").hidden = true;
    log("Approval", e.message);
  }
}
$("approve").onclick = () => decide(true);
$("reject").onclick = () => decide(false);
window.addEventListener("pagehide", () => {
  screenStream?.getTracks().forEach((t) => t.stop());
  navigator.sendBeacon(
    "/api/browser/cancel",
    new Blob([JSON.stringify({ _token: csrfToken })], {
      type: "application/json",
    }),
  );
  if (currentTask && ["working", "paused"].includes(currentTask.status))
    navigator.sendBeacon(
      "/api/task/cancel",
      new Blob([JSON.stringify({ _token: csrfToken, id: currentTask.id })], {
        type: "application/json",
      }),
    );
});
function setChat(open) {
  $("chatPanel").hidden = !open;
  $("toggleChat").setAttribute("aria-pressed", String(open));
  $("toggleChat").classList.toggle("enabled", open);
}
$("toggleChat").onclick = () => setChat($("chatPanel").hidden);
$("closeChat").onclick = () => setChat(false);
$("openSettings").onclick = () => {
  $("settings").showModal();
  void loadMemory();
};
$("closeSettings").onclick = () => $("settings").close();
$("settings").onclick = (e) => {
  if (e.target === $("settings")) $("settings").close();
};
$("browserEnabled").onchange = () => {
  if (!$("browserEnabled").checked) {
    void api("/api/browser/cancel", {}).catch(() => {});
  }
};
setChat(window.innerWidth > 800);
buttons();
function renderTask(task) {
  $("taskPanel").hidden = false;
  $("taskGoal").textContent = task.goal || "Starting your request…";
  $("taskStatus").textContent =
    task.status === "done" ? "Turn complete" : task.status.replace("_", " ");
  $("taskSteps").replaceChildren();
  for (const step of task.steps) {
    const li = document.createElement("li");
    li.textContent = `${step.phase.replace("_", " ")} · ${step.name}: ${step.detail}`;
    $("taskSteps").append(li);
  }
  $("pauseTask").disabled = task.status !== "working";
  $("resumeTask").disabled = task.status !== "paused";
  $("cancelTask").disabled = !["working", "paused"].includes(task.status);
}
async function taskControl(op) {
  if (!currentTask) return;
  try {
    const r = await api("/api/task/" + op, { id: currentTask.id });
    currentTask = await r.json();
    renderTask(currentTask);
    if (op === "cancel") {
      epoch++;
      controller?.abort();
      busy = false;
      pendingApproval = null;
      $("approval").hidden = true;
      resetVAD();
      buttons();
    }
    status(
      op === "pause"
        ? "Task paused. In-flight operations may finish; no new actions will start."
        : op === "resume"
          ? "Resuming task…"
          : "Task cancelled.",
    );
  } catch (e) {
    log("Task", e.message);
  }
}
$("pauseTask").onclick = () => taskControl("pause");
$("resumeTask").onclick = () => taskControl("resume");
$("cancelTask").onclick = () => taskControl("cancel");
function interruptReply() {
  epoch++;
  controller?.abort();
  $("reply").pause();
  busy = false;
  interruptSamples = [];
  interruptDuration = 0;
  resetVAD();
  buttons();
  status(active ? "Listening — you can continue." : "Reply stopped.");
}
$("interruptReply").onclick = interruptReply;
function showNoteDraft(draft) {
  noteDraft = draft;
  setChat(true);
  $("noteDraft").hidden = false;
  $("notePath").textContent = draft.path;
  $("noteContent").value = draft.content;
  $("noteBefore").textContent = draft.previous ?? "(New file)";
}
$("configureFolder").onclick = async () => {
  try {
    const r = await api("/api/files/configure", {
      folder: $("folderPath").value,
    });
    const data = await r.json();
    $("filesEnabled").checked = data.enabled;
    $("folderStatus").textContent = data.enabled
      ? `Enabled: ${data.folder}`
      : "Folder access disabled";
    noteDraft = null;
    $("noteDraft").hidden = true;
  } catch (e) {
    log("Folder", e.message);
  }
};
$("disableFolder").onclick = async () => {
  try {
    await api("/api/files/configure", { folder: "" });
    $("filesEnabled").checked = false;
    $("folderStatus").textContent = "No folder enabled";
    noteDraft = null;
    $("noteDraft").hidden = true;
  } catch (e) {
    log("Folder", e.message);
  }
};
async function reviewNote(approved) {
  if (!noteDraft) return;
  try {
    const r = await api("/api/files/review", {
      id: noteDraft.id,
      approved,
      content: $("noteContent").value,
    });
    const data = await r.json();
    log("Note", data.saved ? `Saved ${data.path}` : "Draft discarded");
  } catch (e) {
    log("Note", e.message);
  } finally {
    noteDraft = null;
    $("noteDraft").hidden = true;
  }
}
$("saveNote").onclick = () => reviewNote(true);
$("discardNote").onclick = () => reviewNote(false);
async function loadMemory() {
  try {
    const r = await api("/api/memory/view", {});
    memoryData = await r.json();
    $("memoryEnabled").checked = memoryData.enabled;
    $("memoryPreferences").value = memoryData.preferences;
    $("memoryFacts").value = memoryData.facts.join("\n");
    $("memorySummaries").value = memoryData.summaries.join("\n\n---\n\n");
  } catch (e) {
    log("Memory", e.message);
  }
}
$("saveMemory").onclick = async () => {
  try {
    const r = await api("/api/memory/save", {
      enabled: $("memoryEnabled").checked,
      preferences: $("memoryPreferences").value,
      facts: $("memoryFacts")
        .value.split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      summaries: $("memorySummaries")
        .value.split("\n\n---\n\n")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    memoryData = await r.json();
    log(
      "Memory",
      memoryData.enabled
        ? "Saved your selected preferences and facts."
        : "Persistence disabled and saved memory deleted.",
    );
  } catch (e) {
    log("Memory", e.message);
  }
};
$("exportMemory").onclick = () =>
  download(
    "live-agent-memory.json",
    JSON.stringify(memoryData, null, 2),
    "application/json",
  );
$("deleteMemory").onclick = async () => {
  try {
    await api("/api/memory/delete", {});
    await loadMemory();
    log("Memory", "Saved memory deleted.");
  } catch (e) {
    log("Memory", e.message);
  }
};
$("exportSession").onclick = () =>
  download(
    "live-agent-session.md",
    history.map((m) => `## ${m.role}\n\n${m.content}`).join("\n\n"),
    "text/markdown",
  );
$("addSummary").onclick = () => {
  const summary = history.map((m) => `${m.role}: ${m.content}`).join("\n");
  if (!summary) {
    log("Memory", "There is no conversation to summarize.");
    return;
  }
  $("memorySummaries").value = [
    $("memorySummaries").value,
    summary.slice(0, 4000),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
  log(
    "Memory",
    "Added a text recap to the preview. Review and Save memory to persist it.",
  );
};
export { visualFrames, interruptReply };
try {
  const r = await fetch("/api/health");
  if (!r.ok) throw Error(await r.text());
  ready = true;
  $("connection").textContent = "Connected locally";
  status("Ready — turn on your microphone or send a message.");
  buttons();
} catch (error) {
  status(
    "Model server unavailable. Run ./start-model.sh, then reload this page.",
  );
}
