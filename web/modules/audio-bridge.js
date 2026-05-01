import { socket } from './socket.js';

const AUDIO_SAMPLE_RATE = 44100; // Use a more standard rate for decodeAudioData compatibility
const RAW_SAMPLE_RATE = 16000;  // Original rate for raw PCM

let phoneAudioCtx = null;
let webMicSource = null;
let webMicProcessor = null;
let phoneAudioEnabled = false;
let injectBotAudioEnabled = true;
let phoneNextPlayTime = 0;
let botNextPlayTime = 0;
let micStream = null;

// Audio activity indicator for UI feedback
let onAudioActivity = null;
export function setOnAudioActivity(cb) {
  onAudioActivity = cb;
}

export function setPhoneAudioEnabled(enabled) {
  phoneAudioEnabled = enabled;
}

export function setInjectBotAudioEnabled(enabled) {
  injectBotAudioEnabled = enabled;
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
  if (!phoneAudioCtx || phoneAudioCtx.state === "closed") {
    phoneAudioCtx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
    phoneNextPlayTime = 0;
    botNextPlayTime = 0;
  }
  if (phoneAudioCtx.state === "suspended") {
    phoneAudioCtx.resume();
  }
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
  webMicProcessor = streamCtx.createScriptProcessor(1024, 1, 1);

  const targetRate = RAW_SAMPLE_RATE;
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
  botNextPlayTime = 0;

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

// Handle incoming audio from Phone (Mic)
socket.on("audio:phone", (data) => {
  if (!phoneAudioEnabled) return;
  ensurePhoneAudioCtx();

  const ab = data instanceof ArrayBuffer ? data : data.buffer || data;
  const i16 = new Int16Array(ab);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

  const buf = phoneAudioCtx.createBuffer(1, f32.length, RAW_SAMPLE_RATE);
  buf.copyToChannel(f32, 0);

  const srcNode = phoneAudioCtx.createBufferSource();
  srcNode.buffer = buf;
  srcNode.connect(phoneAudioCtx.destination);

  const now = phoneAudioCtx.currentTime;
  if (phoneNextPlayTime < now + 0.02) phoneNextPlayTime = now + 0.02;
  srcNode.start(phoneNextPlayTime);
  phoneNextPlayTime += buf.duration;
});

// Handle incoming audio from Bot (TTS)
socket.on("audio:bot", async (data) => {
  if (!injectBotAudioEnabled) return;
  
  const ab = data instanceof ArrayBuffer ? data : data.buffer || data;
  if (!ab || ab.byteLength === 0) {
    console.warn("[AUDIO] Received empty audio:bot data");
    return;
  }

  console.log(`[AUDIO] Received bot audio: ${ab.byteLength} bytes`);
  ensurePhoneAudioCtx();
  
  if (phoneAudioCtx.state === "suspended") {
    console.log("[AUDIO] AudioContext suspended, attempting to resume...");
    await phoneAudioCtx.resume();
  }

  // Detection of common audio formats (MP3/WAV) to use decodeAudioData
  const header = new Uint8Array(ab.slice(0, 4));
  const isMp3 = (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) || // ID3
                (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0); // Sync word or raw frames
  const isWav = (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46); // RIFF

  if (isMp3 || isWav) {
    const format = isMp3 ? "MP3" : "WAV";
    try {
      console.log(`[AUDIO] Decoding ${format} audio...`);
      // Use a copy for decodeAudioData to avoid detaching issues
      const audioBuf = await phoneAudioCtx.decodeAudioData(ab.slice(0));
      console.log(`[AUDIO] Decoded ${format} successfully: ${audioBuf.duration.toFixed(2)}s`);
      
      const srcNode = phoneAudioCtx.createBufferSource();
      srcNode.buffer = audioBuf;
      srcNode.connect(phoneAudioCtx.destination);

      const now = phoneAudioCtx.currentTime;
      if (botNextPlayTime < now + 0.05) botNextPlayTime = now + 0.05;
      srcNode.start(botNextPlayTime);
      botNextPlayTime += audioBuf.duration;

      if (onAudioActivity) onAudioActivity(true);
      srcNode.onended = () => { if (onAudioActivity) onAudioActivity(false); };
      return; 
    } catch (e) {
      console.error(`[AUDIO] Failed to decode ${format} bot audio:`, e);
    }
  }

  console.log("[AUDIO] Playing as raw PCM 16bit...");
  // Fallback to raw PCM 16bit (OpenAI/Chatterbox stripped)
  const i16 = new Int16Array(ab);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

  const buf = phoneAudioCtx.createBuffer(1, f32.length, RAW_SAMPLE_RATE);
  buf.copyToChannel(f32, 0);

  const srcNode = phoneAudioCtx.createBufferSource();
  srcNode.buffer = buf;
  srcNode.connect(phoneAudioCtx.destination);

  const now = phoneAudioCtx.currentTime;
  if (botNextPlayTime < now + 0.05) botNextPlayTime = now + 0.05;
  srcNode.start(botNextPlayTime);
  botNextPlayTime += buf.duration;
  
  if (onAudioActivity) onAudioActivity(true);
  srcNode.onended = () => { if (onAudioActivity) onAudioActivity(false); };
});
