import { invoke } from "@tauri-apps/api/tauri";
import { toast } from "react-toastify";
import { ISTTReceiver, ISTTService } from "../types";
import { STT_State } from "../schema";

const TARGET_SAMPLE_RATE = 16000;
const TOAST_ID = "stt-local-server";
// how long to wait for the server to accept connections after it reported "running"
const CONNECT_TIMEOUT_MS = 10 * 60 * 1000;

type ServerStatus = { phase: "idle" | "preparing" | "running" | "failed"; message: string; log: string };
type EngineSettings = { device: string; language: string; interim: boolean; model?: string };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Base class for the local speech engines (Whisper, Parakeet, Nemotron, Vosk, Moonshine).
 *
 * Captures the microphone, converts it to 16 kHz mono 16-bit PCM and streams it over a
 * WebSocket to the local speech server (stt_server.py). By default Curses starts that
 * server itself (first time: it also installs the engine) and stops it again on Stop.
 *
 * Server messages: { type: "ready" | "status" | "interim" | "final" | "error", ... }
 */
export abstract class STT_LocalServerService implements ISTTService {
  protected abstract engine: string;
  protected abstract label: string;
  protected abstract settings(state: STT_State): EngineSettings;

  constructor(private bindings: ISTTReceiver) {}

  dispose(): void {
    this.stop();
  }

  #socket?: WebSocket;
  #stream?: MediaStream;
  #context?: AudioContext;
  #source?: MediaStreamAudioSourceNode;
  #processor?: ScriptProcessorNode;
  #stoppedByUser = false;
  #reported = false;
  #managed = false;
  #run = 0;

  /** Make sure onStop is only reported once per session. */
  #report(error?: string) {
    if (this.#reported)
      return;
    this.#reported = true;
    toast.dismiss(TOAST_ID);
    if (this.#managed)
      invoke("plugin:stt_server|stop").catch(() => {});
    this.bindings.onStop(error);
  }

  #progress(message: string) {
    const text = `[${this.label}] ${message}`;
    if (toast.isActive(TOAST_ID))
      toast.update(TOAST_ID, { render: text });
    else
      toast.loading(text, { toastId: TOAST_ID });
  }

  #cleanupAudio() {
    try { this.#processor?.disconnect(); } catch {}
    try { this.#source?.disconnect(); } catch {}
    this.#stream?.getTracks().forEach(t => t.stop());
    this.#context?.close().catch(() => {});
    this.#processor = undefined;
    this.#source = undefined;
    this.#stream = undefined;
    this.#context = undefined;
  }

  #floatToPcm16(input: Float32Array): ArrayBuffer {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  #cancelled(run: number) {
    return this.#stoppedByUser || run !== this.#run;
  }

  /** Starts the server (managed mode) and waits until it can be connected to. */
  async #prepareServer(state: STT_State, cfg: EngineSettings, run: number): Promise<void> {
    const port = parseInt(state.localServer.port, 10);
    if (!(port >= 1024 && port <= 65535))
      throw new Error("The server port must be a number between 1024 and 65535.");

    if (!this.#managed)
      return;

    await invoke("plugin:stt_server|start", {
      engine: this.engine,
      model: cfg.model ?? null,
      language: cfg.language === "auto" ? null : cfg.language,
      port,
    });

    this.#progress("Preparing the speech server...");
    for (;;) {
      if (this.#cancelled(run)) return;
      const s = await invoke<ServerStatus>("plugin:stt_server|status");
      if (this.#cancelled(run)) return;
      if (s.phase === "failed") {
        const tail = (s.log || "").trim().split("\n").slice(-6).join("\n");
        throw new Error(tail ? `${s.message}\n${tail}` : s.message);
      }
      if (s.phase === "running")
        return;
      this.#progress(s.message);
      await sleep(700);
    }
  }

  /** Opens the WebSocket, retrying while the server is still loading its model. */
  async #connect(url: string, run: number): Promise<WebSocket> {
    const deadline = Date.now() + (this.#managed ? CONNECT_TIMEOUT_MS : 0);
    for (;;) {
      if (this.#cancelled(run)) throw new Error("cancelled");
      const socket = await new Promise<WebSocket | undefined>((resolve) => {
        let ws: WebSocket;
        try { ws = new WebSocket(url); } catch { return resolve(undefined); }
        ws.binaryType = "arraybuffer";
        ws.onopen = () => resolve(ws);
        ws.onerror = () => resolve(undefined);
        ws.onclose = () => resolve(undefined);
      });
      if (socket) return socket;
      if (!this.#managed || Date.now() > deadline)
        throw new Error(`Cannot reach the speech server at ${url}.`);
      if (this.#cancelled(run)) throw new Error("cancelled");
      // the server may have crashed while loading: report that instead of waiting
      const s = await invoke<ServerStatus>("plugin:stt_server|status").catch(() => undefined);
      if (s?.phase === "failed") {
        const tail = (s.log || "").trim().split("\n").slice(-6).join("\n");
        throw new Error(tail ? `${s.message}\n${tail}` : s.message);
      }
      this.#progress("Loading the speech model (first time can take a while)...");
      await sleep(500);
    }
  }

  start(state: STT_State): void {
    const cfg = this.settings(state);
    const port = state.localServer.port;
    const url = `ws://127.0.0.1:${port}`;

    this.#stoppedByUser = false;
    this.#reported = false;
    this.#managed = !!state.localServer.manage;
    const run = ++this.#run;

    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: cfg.device ? { ideal: cfg.device } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      }
    };

    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e: any) {
        return this.#report(`[${this.label}] Microphone error: ${e?.message ?? e}`);
      }
      if (this.#cancelled(run)) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      this.#stream = stream;

      let socket: WebSocket;
      try {
        await this.#prepareServer(state, cfg, run);
        if (this.#cancelled(run)) return;
        socket = await this.#connect(url, run);
        if (this.#cancelled(run)) {
          socket.close();
          return;
        }
      } catch (e: any) {
        this.#cleanupAudio();
        if (this.#cancelled(run))
          return this.#report();
        return this.#report(`[${this.label}] ${e?.message ?? e}`);
      }

      this.#socket = socket;
      socket.send(JSON.stringify({
        type: "config",
        language: cfg.language === "auto" ? null : cfg.language,
        interim: !!cfg.interim,
      }));

      socket.onmessage = (e) => {
        if (typeof e.data !== "string")
          return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "interim" && msg.text)
            this.bindings.onInterim(msg.text);
          else if (msg.type === "final" && msg.text)
            this.bindings.onFinal(msg.text);
          else if (msg.type === "status" && msg.message)
            this.#progress(msg.message);
          else if (msg.type === "ready")
            toast.dismiss(TOAST_ID);
          else if (msg.type === "error") {
            this.#report(`[${this.label}] ${msg.message ?? "Server error"}`);
            this.stop();
          }
        } catch (_) {}
      };

      socket.onclose = () => {
        this.#cleanupAudio();
        this.#socket = undefined;
        if (this.#stoppedByUser)
          this.#report();
        else
          this.#report(`[${this.label}] The speech server closed the connection.`);
      };

      try {
        const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
        this.#context = context;
        this.#source = context.createMediaStreamSource(stream);
        // ScriptProcessor is deprecated but works everywhere, including WebView2.
        this.#processor = context.createScriptProcessor(4096, 1, 1);
        this.#processor.onaudioprocess = (ev) => {
          if (socket.readyState !== WebSocket.OPEN)
            return;
          socket.send(this.#floatToPcm16(ev.inputBuffer.getChannelData(0)));
        };
        this.#source.connect(this.#processor);
        // the processor only runs while connected to a destination
        this.#processor.connect(context.destination);
        this.bindings.onStart();
      } catch (e) {
        this.#cleanupAudio();
        socket.close();
        this.#report(`[${this.label}] Could not start audio capture: ${e}`);
      }
    })();
  }

  stop(): void {
    this.#stoppedByUser = true;
    this.#run++;
    this.#cleanupAudio();
    toast.dismiss(TOAST_ID);
    if (this.#socket && this.#socket.readyState <= WebSocket.OPEN) {
      this.#socket.close(); // onclose reports the stop
    } else {
      this.#report();
    }
  }
}
