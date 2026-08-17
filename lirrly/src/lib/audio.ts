export interface Recorder {
  analyser: AnalyserNode;
  stop: () => Promise<Blob>;
}

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

export async function startRecording(deviceId?: string): Promise<Recorder> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(buildConstraints(deviceId));
  } catch (e) {
    // The chosen mic may have been unplugged — fall back to the system default
    // instead of failing the dictation.
    if (deviceId && e instanceof Error && e.name === "OverconstrainedError") {
      stream = await navigator.mediaDevices.getUserMedia(buildConstraints());
    } else {
      throw e;
    }
  }

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.7;
  source.connect(analyser);

  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  rec.start();

  return {
    analyser,
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.onstop = () => {
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          stream.getTracks().forEach((t) => t.stop());
          void ctx.close();
          resolve(blob);
        };
        rec.stop();
      }),
  };
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
