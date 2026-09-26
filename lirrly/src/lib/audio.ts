export interface Recorder {
  analyser: AnalyserNode;
  /** Resolve the captured audio and release the microphone. Safe to call twice:
   *  the second call returns the same promise rather than recording again. */
  stop: () => Promise<Blob>;
  /** Release the microphone without producing audio — for a start that lost a
   *  race, a component unmounting, or an abandoned take. Never throws. */
  dispose: () => void;
}

/** MediaRecorder reports its own mimeType, but an empty string is legal; the
 *  Groq upload needs a concrete type to pick a filename extension. */
const FALLBACK_MIME = "audio/webm";
/** 128 frequency bins — enough resolution for the FlowBar's bar meter without
 *  spending a large FFT on decoration. */
const ANALYSER_FFT_SIZE = 256;
/** Heavy smoothing: the meter should read as breath, not as a seismograph. */
const ANALYSER_SMOOTHING = 0.7;

function pickMime(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return "";
}

function buildConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  };
}

async function openStream(deviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(buildConstraints(deviceId));
  } catch (e) {
    // The chosen mic may have been unplugged — fall back to the system default
    // instead of failing the dictation.
    if (deviceId && e instanceof Error && e.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia(buildConstraints());
    }
    throw e;
  }
}

export async function startRecording(deviceId?: string): Promise<Recorder> {
  const stream = await openStream(deviceId);

  // The microphone is live from here on. Every exit path below — success,
  // construction failure, recorder error, abandonment — must run `release`, or
  // the OS keeps the mic open with nobody owning the session.
  let ctx: AudioContext | null = null;
  let released = false;
  function release() {
    if (released) return;
    released = true;
    stream.getTracks().forEach((track) => track.stop());
    // close() rejects only when the context is already closed. There is nothing
    // to recover and nothing worth telling the user; the tracks above are what
    // actually turn the microphone indicator off.
    if (ctx) void ctx.close().catch(() => undefined);
  }

  try {
    ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
    source.connect(analyser);

    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    // A recorder error (device yanked mid-take) never fires `onstop`, so release
    // here too. `stop()` still resolves with whatever was captured before it.
    rec.onerror = () => release();
    rec.start();

    let stopping: Promise<Blob> | null = null;
    function stop(): Promise<Blob> {
      if (stopping) return stopping;
      stopping = new Promise<Blob>((resolve) => {
        const settle = () => {
          release();
          resolve(new Blob(chunks, { type: rec.mimeType || FALLBACK_MIME }));
        };
        rec.onstop = settle;
        try {
          rec.stop();
        } catch {
          // Already inactive — `onstop` will never fire, and awaiting it would
          // hang the dictation forever. The chunks captured so far are still
          // valid audio, so settle with them now.
          settle();
        }
      });
      return stopping;
    }

    return { analyser, stop, dispose: release };
  } catch (e) {
    release();
    throw e;
  }
}

/** Labeled input devices. Labels are only available after a mic permission
 *  grant, so this probes getUserMedia once (and immediately stops it). */
export async function listMicrophones(): Promise<{ deviceId: string; label: string }[]> {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let inputs = devices.filter((d) => d.kind === "audioinput");
    if (inputs.length && inputs.every((d) => !d.label)) {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      inputs = devices.filter((d) => d.kind === "audioinput");
    }
    return inputs
      .filter((d) => d.deviceId && d.deviceId !== "default")
      .map((d) => ({ deviceId: d.deviceId, label: d.label || "Microphone" }));
  } catch {
    // No permission yet (or no devices) — the caller shows "System Default" only.
    return [];
  }
}
