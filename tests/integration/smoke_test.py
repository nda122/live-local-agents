import base64
import io
import json
import re
import struct
import wave
import zlib
from urllib.request import Request, urlopen

BASE = "http://127.0.0.1:8765"

with urlopen(BASE + "/") as response:
    TOKEN = re.search(
        r'name="live-agent-token"\s+content="([^"]+)"', response.read().decode()
    ).group(1)


def post(path, data):
    with urlopen(
        Request(
            BASE + path,
            json.dumps(data).encode(),
            {"Content-Type": "application/json", "X-Live-Agent-Token": TOKEN},
        ),
        timeout=180,
    ) as r:
        return r.read()


with urlopen(BASE + "/api/health") as r:
    assert json.load(r)["status"] == "ok"
audio = post(
    "/api/tts",
    {
        "input": "Hello. Can you hear me?",
        "lang": "en",
        "voice": "female",
        "n_predict": 128,
    },
)
with wave.open(io.BytesIO(audio)) as wav:
    assert wav.getframerate() == 24000
    assert wav.getnframes() > 1000

asr = json.loads(
    post(
        "/api/chat",
        {
            "messages": [
                {"role": "system", "content": "Perform ASR in English."},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": base64.b64encode(audio).decode(),
                                "format": "wav",
                            },
                        }
                    ],
                },
            ],
            "temperature": 0,
            "max_tokens": 64,
        },
    )
)
transcript = asr["choices"][0]["message"]["content"]
assert "hear" in transcript.lower(), transcript
print("Native speech synthesis and audio transcription passed:", transcript)


def chunk(kind, data):
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data))
    )


# Synthetic red image, not a camera recording.
png = b"\x89PNG\r\n\x1a\n" + chunk(
    b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0)
)
png += chunk(b"IDAT", zlib.compress((b"\0" + b"\xff\0\0" * 64) * 64)) + chunk(
    b"IEND", b""
)
result = json.loads(
    post(
        "/api/chat",
        {
            "messages": [
                {"role": "system", "content": "Respond with text."},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "data:image/png;base64,"
                                + base64.b64encode(png).decode()
                            },
                        },
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": base64.b64encode(audio).decode(),
                                "format": "wav",
                            },
                        },
                        {
                            "type": "text",
                            "text": "What color is the image? Answer in one sentence.",
                        },
                    ],
                },
            ],
            "temperature": 0,
            "max_tokens": 64,
        },
    )
)
answer = result["choices"][0]["message"]["content"]
assert "red" in answer.lower(), answer
print("Combined image and audio input passed:", answer)

request = Request(
    BASE + "/api/chat",
    b"{}",
    {"Origin": "https://example.com", "Content-Type": "application/json"},
)
try:
    urlopen(request)
except Exception as error:
    assert getattr(error, "code", None) == 403, error
else:
    raise AssertionError("Cross-origin request was accepted")
print("Cross-origin request rejection passed.")
