import { socket } from './socket.js';

const AUDIO_SAMPLE_RATE = 16000;

let phoneAudioCtx = null;
let webMicSource = null;
let webMicProcessor = null;
let phoneAudioEnabled = false;
let phoneNextPlayTime = 0;
let micStream = null;

export function setPhoneAudioEnabled(enabled) {
  phoneAudioEnabled = enabled;
}

export async function startMic() {
  if (micStream) return micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return micStream;
  } catch (e) {
    console.error("Mic denied", e);
    return null;
  }
}

export function stopMic() {
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (webMicProcessor) {
    webMicProcessor.disconnect();
    webMicSource.disconnect();
    webMicProcessor = null;
    webMicSource = null;
  }
}

export function ensurePhoneAudioCtx() {
  if (phoneAudioCtx && phoneAudioCtx.state !== "closed") return;
  phoneAudioCtx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  phoneNextPlayTime = 0;
}

export async function startWebMicStreaming() {
  if (webMicProcessor) return;

  if (!micStream) await startMic();
  if (!micStream) return;

  let streamCtx;
  try {
    streamCtx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  } catch {
    streamCtx = new AudioContext();
  }

  webMicSource = streamCtx.createMediaStreamSource(micStream);
  webMicProcessor = streamCtx.createScriptProcessor(1280, 1, 1);

  const targetRate = AUDIO_SAMPLE_RATE;
  const srcRate = streamCtx.sampleRate;

  webMicProcessor.onaudioprocess = (e) => {
    let f32 = e.inputBuffer.getChannelData(0);

    if (srcRate !== targetRate) {
      f32 = downsample(f32, srcRate, targetRate);
    }

    const i16 = float32ToInt16(f32);
    if (socket.connected) {
      socket.emit("audio:dashboard", i16.buffer);
    }
  };

  webMicSource.connect(webMicProcessor);
  webMicProcessor.connect(streamCtx.destination);
}

export function stopPhoneAudio() {
  phoneAudioEnabled = false;
  try { phoneAudioCtx?.close(); } catch { }
  phoneAudioCtx = null;
  phoneNextPlayTime = 0;

  if (webMicProcessor) {
    webMicProcessor.disconnect();
    webMicSource.disconnect();
    webMicProcessor = null;
    webMicSource = null;
  }
}

function downsample(buf, srcRate, dstRate) {
  if (srcRate === dstRate) return buf;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(buf.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = Math.min(Math.floor(i * ratio), buf.length - 1);
    out[i] = buf[idx];
  }
  return out;
}

function float32ToInt16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return i16;
}

// Handle incoming audio
socket.on("audio:phone", (data) => {
  if (!phoneAudioEnabled) return;
  ensurePhoneAudioCtx();

  const ab = data instanceof ArrayBuffer ? data : data.buffer || data;
  const i16 = new Int16Array(ab);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

  const buf = phoneAudioCtx.createBuffer(1, f32.length, AUDIO_SAMPLE_RATE);
  buf.copyToChannel(f32, 0);

  const srcNode = phoneAudioCtx.createBufferSource();
  srcNode.buffer = buf;
  srcNode.connect(phoneAudioCtx.destination);

  const now = phoneAudioCtx.currentTime;
  if (phoneNextPlayTime < now + 0.02) phoneNextPlayTime = now + 0.02;
  srcNode.start(phoneNextPlayTime);
  phoneNextPlayTime += buf.duration;
});
