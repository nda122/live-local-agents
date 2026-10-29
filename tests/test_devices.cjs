const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
class Element {
  constructor() {
    this.value = "";
    this.hidden = false;
    this.checked = false;
    this.dataset = {};
    this.parentElement = { scrollTop: 0, scrollHeight: 100 };
    this.classList = { toggle() {} };
    this.children = [];
  }
  setAttribute(k, v) {
    this[k] = v;
  }
  append(...v) {
    this.children.push(...v);
  }
  replaceChildren() {
    this.children = [];
  }
  getContext() {
    return { drawImage() {} };
  }
  toDataURL() {
    return "data:image/jpeg;base64,test";
  }
  play() {
    return Promise.resolve();
  }
  pause() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, new Element());
  return elements.get(id);
};
element("vision").checked = true;
element("visualSource").value = "camera";
element("threshold").value = ".018";
element("voice").value = "female";
const requests = [],
  captures = [];
function media(kind) {
  const track = {
    kind,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => (kind === "audio" ? [track] : []),
    getVideoTracks: () => (kind === "video" ? [track] : []),
  };
  captures.push(stream);
  return stream;
}
class AudioContext {
  constructor() {
    this.audioWorklet = { addModule: async () => {} };
    this.sampleRate = 48000;
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return {
      connect() {
        return this;
      },
      disconnect() {},
    };
  }
  createGain() {
    return {
      gain: { value: 1 },
      connect() {
        return this;
      },
      disconnect() {},
    };
  }
}
class AudioWorkletNode {
  constructor() {
    this.port = {};
  }
  connect() {
    return this;
  }
  disconnect() {}
}
const context = vm.createContext({
  document: {
    querySelector: () => ({ content: "test-token" }),
    getElementById: element,
    createElement: () => new Element(),
  },
  window: { innerWidth: 1280, addEventListener() {} },
  navigator: {
    mediaDevices: {
      getUserMedia: async (c) => {
        requests.push(c);
        return media(c.audio ? "audio" : "video");
      },
      getDisplayMedia: async () => media("video"),
    },
    sendBeacon() {},
  },
  fetch: async () => ({
    ok: true,
    json: async () => ({
      enabled: false,
      preferences: "",
      facts: [],
      summaries: [],
    }),
  }),
  AudioContext,
  AudioWorkletNode,
  AbortController,
  DOMException,
  URL,
  Blob,
  console,
  TextDecoder,
  performance,
});
(async () => {
  const app = new vm.SourceTextModule(
    fs.readFileSync(__dirname + "/../web/app.js", "utf8"),
    { context },
  );
  const apiModule = new vm.SourceTextModule(
    fs.readFileSync(__dirname + "/../web/api.js", "utf8"),
    { context },
  );
  await app.link((spec) => {
    if (spec === "./api.js") return apiModule;
    throw Error("Unexpected import " + spec);
  });
  await app.evaluate();
  await element("toggleCamera").onclick();
  assert.equal(requests[0].audio, false);
  assert.ok(requests[0].video);
  assert.equal(element("toggleMic")["aria-pressed"], "false");
  await element("toggleMic").onclick();
  assert.equal(requests[1].video, false);
  assert.ok(requests[1].audio);
  assert.equal(element("toggleCamera")["aria-pressed"], "true");
  await element("toggleCamera").onclick();
  assert.equal(captures[0].getTracks()[0].stopped, true);
  assert.equal(captures[1].getTracks()[0].stopped, false);
  assert.equal(element("toggleMic")["aria-pressed"], "true");
  await element("toggleCamera").onclick();
  element("camera").videoWidth = 640;
  element("camera").videoHeight = 480;
  await element("toggleScreen").onclick();
  element("screenPreview").videoWidth = 1280;
  element("screenPreview").videoHeight = 720;
  assert.deepEqual(
    Array.from(app.namespace.visualFrames(), (v) => v.name),
    ["Camera", "Shared screen"],
  );
  assert.equal(element("toggleScreen")["aria-pressed"], "true");
  assert.equal(element("toggleMic")["aria-pressed"], "true");
  await element("toggleMic").onclick();
  assert.equal(captures[1].getTracks()[0].stopped, true);
  assert.equal(captures[3].getTracks()[0].stopped, false);
  await element("stop").onclick();
  assert.ok(captures.every((s) => s.getTracks().every((t) => t.stopped)));
  assert.equal(element("toggleScreen")["aria-pressed"], "false");
  element("openSettings").onclick();
  assert.equal(element("settings").open, true);
  element("closeSettings").onclick();
  assert.equal(element("settings").open, false);
  element("toggleChat").onclick();
  assert.equal(element("chatPanel").hidden, true);
  element("toggleChat").onclick();
  assert.equal(element("chatPanel").hidden, false);
  console.log(
    "PASS: independent camera/mic/screen, Stop releases every track, settings, chat toggle",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
