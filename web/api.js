export const csrfToken =
  document.querySelector('meta[name="live-agent-token"]')?.content || "";
export async function api(path, body, signal) {
  const r = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Agent-Token": csrfToken,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const text = await r.text();
    let error;
    try {
      error = JSON.parse(text).error;
    } catch {}
    throw Error(error?.message || text || `HTTP ${r.status}`);
  }
  return r;
}
export async function chat(messages, signal, max_tokens = 160) {
  const r = await api(
    "/api/chat",
    { messages, temperature: 0, max_tokens, stream: false },
    signal,
  );
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text?.trim())
    throw Error("Model returned no text. Check the llama server log.");
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
