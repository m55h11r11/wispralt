import { beforeEach, describe, expect, it } from "vitest";
import { startRecording } from "./audio";

/* Test doubles for the three browser APIs a recording touches. happy-dom
   provides none of them, so they are installed on globalThis per test. The
   `as unknown as` casts are the standard shape-compatible-double pattern:
   these fakes implement only the surface `startRecording` actually uses. */

class FakeTrack {
  stopped = 0;
  stop() {
    this.stopped += 1;
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;
  /** Set to make `stop()` throw the way a real recorder does when it is already
   *  inactive — the case that used to hang the dictation forever. */
  static throwOnStop = false;
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  started = 0;
  constructor() {
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.started += 1;
  }
  stop() {
    if (FakeMediaRecorder.throwOnStop) throw new Error("InvalidStateError");
    this.onstop?.();
  }
}

class FakeAudioContext {
  /** One-shot: makes the next construction fail, simulating "no audio device"
   *  after the microphone has already been granted. */
  static failNext = false;
  closed = 0;
  constructor() {
    if (FakeAudioContext.failNext) {
      FakeAudioContext.failNext = false;
      throw new Error("audio device unavailable");
    }
  }
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
  createAnalyser() {
    return { fftSize: 0, smoothingTimeConstant: 0 };
  }
  close() {
    this.closed += 1;
    return Promise.resolve();
  }
}

let stream: FakeStream;

beforeEach(() => {
  stream = new FakeStream();
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.throwOnStop = false;
  FakeAudioContext.failNext = false;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: { getUserMedia: () => Promise.resolve(stream) },
    writable: true,
    configurable: true,
  });
  globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
});

const tracksStopped = () => stream.tracks.map((t) => t.stopped);

describe("startRecording owns the microphone", () => {
  it("releases the microphone exactly once on a normal stop", async () => {
    const recorder = await startRecording();
    expect(tracksStopped()).toEqual([0]);
    const blob = await recorder.stop();
    expect(blob).toBeInstanceOf(Blob);
    expect(tracksStopped()).toEqual([1]);
  });

  it("is idempotent: stopping twice records one release and one take", async () => {
    const recorder = await startRecording();
    const [first, second] = await Promise.all([recorder.stop(), recorder.stop()]);
    expect(first).toBe(second);
    expect(tracksStopped()).toEqual([1]);
  });

  it("dispose() releases an abandoned recording", async () => {
    const recorder = await startRecording();
    recorder.dispose();
    expect(tracksStopped()).toEqual([1]);
    recorder.dispose();
    expect(tracksStopped()).toEqual([1]);
  });

  it("stop() after dispose() still settles instead of hanging", async () => {
    const recorder = await startRecording();
    recorder.dispose();
    await expect(recorder.stop()).resolves.toBeInstanceOf(Blob);
  });

  it("settles when the recorder is already inactive and stop() throws", async () => {
    const recorder = await startRecording();
    FakeMediaRecorder.throwOnStop = true;
    await expect(recorder.stop()).resolves.toBeInstanceOf(Blob);
    expect(tracksStopped()).toEqual([1]);
  });

  it("releases the granted microphone when setup fails after getUserMedia", async () => {
    FakeAudioContext.failNext = true;
    await expect(startRecording()).rejects.toThrow("audio device unavailable");
    // The permission was granted before the failure — the mic must not stay live.
    expect(tracksStopped()).toEqual([1]);
  });

  it("releases the microphone when the recorder itself errors", async () => {
    await startRecording();
    const rec = FakeMediaRecorder.instances[0];
    rec.onerror?.();
    expect(tracksStopped()).toEqual([1]);
  });
});
