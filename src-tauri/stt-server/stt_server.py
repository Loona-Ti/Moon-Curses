#!/usr/bin/env python3
"""
Moon Curses local speech-to-text server.

Moon Curses starts and stops this program for you. It listens on a local
WebSocket (default ws://127.0.0.1:8765). The app streams raw microphone audio
(16 kHz, mono, 16-bit PCM) to it and receives JSON back:

    {"type": "interim", "text": "..."}   live partial text while you speak
    {"type": "final",   "text": "..."}   a finished phrase
    {"type": "status",  "message": "..."} progress information (model loading ...)

The first message from the client is a config message:
    {"type": "config", "language": "en" | null, "interim": true}

Engines (--engine):
    whisper    faster-whisper (CUDA GPU if available, otherwise CPU)
    parakeet   NVIDIA Parakeet TDT 0.6B v3 through onnx-asr (CPU, int8)
    nemotron   NVIDIA Nemotron Speech Streaming through Hugging Face Transformers
    vosk       Vosk (Kaldi), tiny and truly streaming
    moonshine  Moonshine Voice, small and streaming

Only accepts connections from this PC (127.0.0.1) unless --host is changed.
"""

import argparse
import asyncio
import glob
import json
import os
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import numpy as np

SAMPLE_RATE = 16000
BLOCK = 1600                 # 0.1 s of audio
BLOCK_S = BLOCK / SAMPLE_RATE
SILENCE_END_S = 0.6          # pause that ends a phrase
MAX_SEGMENT_S = 20.0         # force a final result after this much speech
PRE_ROLL_BLOCKS = 3          # 0.3 s kept before speech starts
MIN_SPEECH_S = 0.3           # ignore shorter blips
INTERIM_EVERY_S = 1.0        # how often to refresh the live partial text
MIN_INTERIM_S = 0.5

ENGINES = ("whisper", "parakeet", "nemotron", "vosk", "moonshine")


def log(*args):
    print(*args, flush=True)


def add_nvidia_dll_dirs():
    """On Windows, make pip-installed CUDA libraries (cuBLAS/cuDNN) findable."""
    if sys.platform != "win32":
        return
    for base in sys.path:
        for d in glob.glob(os.path.join(base, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(d)
            except (OSError, AttributeError):
                pass
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def result_text(res):
    """Turn whatever a recognizer returns into a plain string."""
    if res is None:
        return ""
    if isinstance(res, str):
        return res.strip()
    if isinstance(res, (list, tuple)):
        return " ".join(result_text(r) for r in res).strip()
    text = getattr(res, "text", None)
    return (text if isinstance(text, str) else str(res)).strip()


# --------------------------------------------------------------------------
# Engine interfaces
# --------------------------------------------------------------------------
class SegmentEngine:
    """Transcribes a finished chunk of audio. The server finds the phrases."""
    kind = "segment"
    name = ""
    model_name = ""
    device_label = "CPU"

    def transcribe(self, audio, language, final):  # audio: float32 mono 16 kHz
        raise NotImplementedError

    def preload(self, language):
        pass


class StreamEngine:
    """Consumes a continuous audio stream and reports text as it goes."""
    kind = "stream"
    name = ""
    model_name = ""
    device_label = "CPU"

    def open(self, language, emit):  # returns a stream with feed() and close()
        raise NotImplementedError

    def preload(self, language):
        pass


# --------------------------------------------------------------------------
# Whisper (faster-whisper)
# --------------------------------------------------------------------------
class WhisperEngine(SegmentEngine):
    name = "whisper"

    def __init__(self, model_name, device_pref):
        from faster_whisper import WhisperModel

        self.model_name = model_name
        add_nvidia_dll_dirs()

        have_cuda = False
        if device_pref in ("auto", "cuda"):
            try:
                import ctranslate2
                have_cuda = ctranslate2.get_cuda_device_count() > 0
            except Exception:
                pass

        self.model = None
        if have_cuda:
            try:
                log(f"Loading Whisper '{model_name}' on GPU (first run downloads the model)...")
                model = WhisperModel(model_name, device="cuda", compute_type="float16")
                noise = (np.random.randn(SAMPLE_RATE) * 0.01).astype(np.float32)
                list(model.transcribe(noise, vad_filter=False)[0])  # forces CUDA libs to load now
                self.model, self.beam_final, self.device_label = model, 5, "GPU (CUDA)"
            except Exception as e:
                log(f"GPU unavailable ({type(e).__name__}: {e}). Falling back to CPU.")
                if device_pref == "cuda":
                    raise
        if self.model is None:
            log(f"Loading Whisper '{model_name}' on CPU (first run downloads the model)...")
            self.model = WhisperModel(model_name, device="cpu", compute_type="int8")
            self.beam_final, self.device_label = 1, "CPU (int8)"
        self._lock = threading.Lock()  # one transcription at a time

    def transcribe(self, audio, language, final):
        with self._lock:
            segments, _info = self.model.transcribe(
                audio,
                language=language,
                beam_size=self.beam_final if final else 1,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            return " ".join(s.text.strip() for s in segments).strip()


# --------------------------------------------------------------------------
# NVIDIA Parakeet TDT 0.6B v3 (onnx-asr)
# --------------------------------------------------------------------------
class ParakeetEngine(SegmentEngine):
    name = "parakeet"
    model_name = "nemo-parakeet-tdt-0.6b-v3"

    def __init__(self, device_pref):
        import onnx_asr

        log("Loading Parakeet TDT 0.6B v3 (first run downloads about 650 MB)...")
        self.model = onnx_asr.load_model(self.model_name, quantization="int8")
        self.device_label = "CPU (int8)"
        self._lock = threading.Lock()
        # warm-up so the first real phrase is fast
        self.model.recognize(np.zeros(SAMPLE_RATE, dtype=np.float32), sample_rate=SAMPLE_RATE)

    def transcribe(self, audio, language, final):
        with self._lock:
            return result_text(self.model.recognize(audio, sample_rate=SAMPLE_RATE))


# --------------------------------------------------------------------------
# Splitting an audio stream into phrases
# --------------------------------------------------------------------------
class Segmenter:
    """Energy-based phrase detector. feed() returns events: (kind, seg_id, audio)."""

    def __init__(self):
        self.pending = np.zeros(0, dtype=np.float32)
        self.noise = 0.005
        self.pre = deque(maxlen=PRE_ROLL_BLOCKS)
        self.buf = []
        self.in_speech = False
        self.silence = 0.0
        self.speech_len = 0.0
        self.since_interim = 0.0
        self.seg_id = 0

    def feed(self, samples):
        events = []
        self.pending = np.concatenate([self.pending, samples])
        while len(self.pending) >= BLOCK:
            block, self.pending = self.pending[:BLOCK], self.pending[BLOCK:]
            events.extend(self._block(block))
        return events

    def flush(self):
        events = []
        if self.in_speech:
            events.extend(self._finish())
        return events

    def _finish(self):
        events = []
        if self.buf and self.speech_len >= MIN_SPEECH_S:
            events.append(("final", self.seg_id, np.concatenate(self.buf)))
        self.seg_id += 1
        self.buf = []
        self.in_speech = False
        self.silence = 0.0
        self.speech_len = 0.0
        self.since_interim = 0.0
        return events

    def _block(self, block):
        rms = float(np.sqrt(np.mean(block ** 2)))
        loud = rms > max(0.01, self.noise * 3.0)
        if not self.in_speech and not loud:
            self.noise = 0.95 * self.noise + 0.05 * rms  # adapt to room noise

        events = []
        if loud and not self.in_speech:
            self.in_speech = True
            self.buf = list(self.pre)

        if self.in_speech:
            self.buf.append(block)
            if loud:
                self.silence = 0.0
                self.speech_len += BLOCK_S
            else:
                self.silence += BLOCK_S
            self.since_interim += BLOCK_S
            total = len(self.buf) * BLOCK_S

            if self.silence >= SILENCE_END_S or total >= MAX_SEGMENT_S:
                events.extend(self._finish())
            elif self.since_interim >= INTERIM_EVERY_S and self.speech_len >= MIN_INTERIM_S:
                self.since_interim = 0.0
                events.append(("interim", self.seg_id, np.concatenate(self.buf)))
        else:
            self.pre.append(block)
        return events


class VadGate:
    """Per-block speech gate for streaming engines.

    feed() returns events: ("start", pre_roll_audio), ("audio", block), ("end", None).
    """

    def __init__(self):
        self.pending = np.zeros(0, dtype=np.float32)
        self.noise = 0.005
        self.pre = deque(maxlen=PRE_ROLL_BLOCKS)
        self.in_speech = False
        self.silence = 0.0
        self.total = 0.0

    def feed(self, samples):
        events = []
        self.pending = np.concatenate([self.pending, samples])
        while len(self.pending) >= BLOCK:
            block, self.pending = self.pending[:BLOCK], self.pending[BLOCK:]
            events.extend(self._block(block))
        return events

    def flush(self):
        if self.in_speech:
            self._reset()
            return [("end", None)]
        return []

    def _reset(self):
        self.in_speech = False
        self.silence = 0.0
        self.total = 0.0
        self.pre.clear()

    def _block(self, block):
        rms = float(np.sqrt(np.mean(block ** 2)))
        loud = rms > max(0.01, self.noise * 3.0)
        if not self.in_speech and not loud:
            self.noise = 0.95 * self.noise + 0.05 * rms

        events = []
        if loud and not self.in_speech:
            self.in_speech = True
            pre = np.concatenate(list(self.pre)) if self.pre else np.zeros(0, dtype=np.float32)
            events.append(("start", pre))

        if self.in_speech:
            events.append(("audio", block))
            self.total += BLOCK_S
            self.silence = 0.0 if loud else self.silence + BLOCK_S
            if self.silence >= SILENCE_END_S or self.total >= MAX_SEGMENT_S:
                events.append(("end", None))
                self._reset()
        else:
            self.pre.append(block)
        return events


# --------------------------------------------------------------------------
# NVIDIA Nemotron Speech Streaming (Hugging Face Transformers)
# --------------------------------------------------------------------------
class NemotronEngine(StreamEngine):
    name = "nemotron"
    model_name = "nvidia/nemotron-3.5-asr-streaming-0.6b"

    def __init__(self, device_pref):
        import torch
        from transformers import AutoModelForRNNT, AutoProcessor

        log("Loading Nemotron Speech Streaming 0.6B (first run downloads about 2 GB)...")
        self.torch = torch
        self.processor = AutoProcessor.from_pretrained(self.model_name)
        self.model = AutoModelForRNNT.from_pretrained(self.model_name, device_map="auto")
        self.processor.set_num_lookahead_tokens(6)
        self.device_label = str(self.model.device).replace("cuda", "GPU (CUDA)") \
            if "cuda" in str(self.model.device) else "CPU"
        self.gen_lock = threading.Lock()  # one decoding session at a time

    def open(self, language, emit):
        return NemotronStream(self, language or "auto", emit)


class _NemotronSession:
    """One phrase: audio goes into a buffer, a worker thread decodes it as it arrives."""

    def __init__(self, engine, language, emit):
        self.e = engine
        self.language = language
        self.emit = emit
        self.buf = np.zeros(0, dtype=np.float32)
        self.cond = threading.Condition()
        self.closed = False
        threading.Thread(target=self._run, daemon=True).start()

    def add(self, samples):
        with self.cond:
            self.buf = np.concatenate([self.buf, samples])
            self.cond.notify_all()

    def finish(self):
        # pad with silence so the last words are decoded, then let the worker end
        pad = np.zeros(int(self.e.processor.num_samples_per_audio_chunk * 2), dtype=np.float32)
        with self.cond:
            self.buf = np.concatenate([self.buf, pad])
            self.closed = True
            self.cond.notify_all()

    def _wait_for(self, n):
        with self.cond:
            while len(self.buf) < n:
                if self.closed:
                    return False
                self.cond.wait(0.1)
            return True

    def _run(self):
        try:
            from threading import Thread
            from transformers import TextIteratorStreamer

            p = self.e.processor
            model = self.e.model
            sr = p.feature_extractor.sampling_rate
            first_n = p.num_samples_first_audio_chunk
            if not self._wait_for(first_n):
                return
            with self.cond:
                first_audio = self.buf[:first_n].copy()
            first = p(first_audio, sampling_rate=sr, is_streaming=True, is_first_audio_chunk=True,
                      language=self.language, return_tensors="pt")
            first = first.to(model.device, dtype=model.dtype)

            def features():
                yield first.input_features[:, : p.num_mel_frames_first_audio_chunk, :]
                mel_idx = p.num_mel_frames_first_audio_chunk
                hop = p.feature_extractor.hop_length
                n_fft = p.feature_extractor.n_fft
                start = mel_idx * hop - n_fft // 2
                while True:
                    end = start + p.num_samples_per_audio_chunk
                    if not self._wait_for(end):
                        return
                    with self.cond:
                        chunk = self.buf[start:end].copy()
                    inputs = p(chunk, sampling_rate=sr, is_streaming=True, is_first_audio_chunk=False,
                               language=self.language, return_tensors="pt")
                    inputs = inputs.to(model.device, dtype=model.dtype)
                    yield inputs.input_features
                    mel_idx += p.num_mel_frames_per_audio_chunk
                    start = mel_idx * hop - n_fft // 2

            streamer = TextIteratorStreamer(p.tokenizer, skip_special_tokens=True)

            def generate():
                try:
                    with self.e.gen_lock:
                        model.generate(**{**first, "input_features": features(), "streamer": streamer})
                except Exception as e:
                    log(f"Nemotron decoding error: {e}")
                    streamer.end()

            worker = Thread(target=generate, daemon=True)
            worker.start()
            text = ""
            for piece in streamer:
                text += piece
                self.emit("interim", text.strip())
            worker.join()
            self.emit("final", text.strip())
        except Exception as e:
            log(f"Nemotron session error: {e}")


class NemotronStream:
    def __init__(self, engine, language, emit):
        self.e = engine
        self.language = language
        self.emit = emit
        self.gate = VadGate()
        self.session = None

    def _handle(self, events):
        for kind, data in events:
            if kind == "start":
                self.session = _NemotronSession(self.e, self.language, self.emit)
                if len(data):
                    self.session.add(data)
            elif kind == "audio" and self.session:
                self.session.add(data)
            elif kind == "end" and self.session:
                self.session.finish()
                self.session = None

    def feed(self, pcm16):
        self._handle(self.gate.feed(pcm16.astype(np.float32) / 32768.0))

    def close(self):
        self._handle(self.gate.flush())
        if self.session:
            self.session.finish()
            self.session = None


# --------------------------------------------------------------------------
# Vosk
# --------------------------------------------------------------------------
VOSK_LANG_ALIASES = {"en": "en-us", "zh": "cn", "auto": "en-us", "": "en-us"}


class VoskEngine(StreamEngine):
    name = "vosk"
    model_name = "vosk (small models)"

    def __init__(self, device_pref):
        from vosk import KaldiRecognizer, Model, SetLogLevel

        SetLogLevel(-1)
        self._Model, self._Rec = Model, KaldiRecognizer
        self._models = {}
        self.device_label = "CPU"

    def _lang(self, language):
        language = (language or "").lower()
        return VOSK_LANG_ALIASES.get(language, language)

    def _model(self, lang):
        if lang not in self._models:
            log(f"Loading Vosk model for '{lang}' (first run downloads it)...")
            self._models[lang] = self._Model(lang=lang)
        return self._models[lang]

    def preload(self, language):
        self._model(self._lang(language))

    def open(self, language, emit):
        rec = self._Rec(self._model(self._lang(language)), SAMPLE_RATE)
        return VoskStream(rec, emit)


class VoskStream:
    def __init__(self, rec, emit):
        self.rec = rec
        self.emit = emit
        self.last_partial = ""

    def feed(self, pcm16):
        if self.rec.AcceptWaveform(pcm16.tobytes()):
            text = json.loads(self.rec.Result()).get("text", "").strip()
            self.last_partial = ""
            if text:
                self.emit("final", text)
        else:
            partial = json.loads(self.rec.PartialResult()).get("partial", "").strip()
            if partial and partial != self.last_partial:
                self.last_partial = partial
                self.emit("interim", partial)

    def close(self):
        text = json.loads(self.rec.FinalResult()).get("text", "").strip()
        if text:
            self.emit("final", text)


# --------------------------------------------------------------------------
# Moonshine
# --------------------------------------------------------------------------
class MoonshineEngine(StreamEngine):
    name = "moonshine"
    model_name = "moonshine-voice"

    def __init__(self, device_pref):
        from moonshine_voice import Transcriber, get_model_for_language

        self._Transcriber, self._get_model = Transcriber, get_model_for_language
        self._transcribers = {}
        self.device_label = "CPU"

    @staticmethod
    def _lang(language):
        language = (language or "en").lower().split("-")[0]
        return "en" if language == "auto" else language

    def _transcriber(self, lang):
        if lang not in self._transcribers:
            log(f"Loading Moonshine model for '{lang}' (first run downloads it)...")
            path, arch = self._get_model(lang)
            self._transcribers[lang] = self._Transcriber(model_path=path, model_arch=arch)
        return self._transcribers[lang]

    def preload(self, language):
        self._transcriber(self._lang(language))

    def open(self, language, emit):
        return MoonshineStream(self._transcriber(self._lang(language)), emit)


class MoonshineStream:
    def __init__(self, transcriber, emit):
        from moonshine_voice import TranscriptEventListener

        class Listener(TranscriptEventListener):
            def on_line_text_changed(self, event):
                emit("interim", event.line.text)

            def on_line_completed(self, event):
                emit("final", event.line.text)

        self.stream = transcriber.create_stream(update_interval=0.5)
        self.stream.add_listener(Listener())
        self.stream.start()

    def feed(self, pcm16):
        self.stream.add_audio((pcm16.astype(np.float32) / 32768.0).tolist(), SAMPLE_RATE)

    def close(self):
        self.stream.stop()
        self.stream.close()


# --------------------------------------------------------------------------
# One WebSocket connection (engines that transcribe finished phrases)
# --------------------------------------------------------------------------
class Session:
    def __init__(self, ws, engine):
        self.ws = ws
        self.engine = engine
        self.language = None
        self.want_interim = True
        self.finals = asyncio.Queue()
        self.interim = None          # only the newest interim job is kept
        self.last_final = -1
        self.wake = asyncio.Event()

    def submit(self, event):
        kind, seg_id, audio = event
        if kind == "final":
            self.finals.put_nowait(event)
        elif self.want_interim:
            self.interim = event
        self.wake.set()

    async def worker(self):
        loop = asyncio.get_running_loop()
        while True:
            await self.wake.wait()
            self.wake.clear()
            while True:
                if not self.finals.empty():
                    job = self.finals.get_nowait()
                elif self.interim is not None:
                    job, self.interim = self.interim, None
                else:
                    break
                kind, seg_id, audio = job
                if kind == "interim" and seg_id <= self.last_final:
                    continue  # that phrase is already finished
                try:
                    text = await loop.run_in_executor(
                        None, self.engine.transcribe, audio, self.language, kind == "final"
                    )
                except Exception as e:
                    log(f"Transcription error: {e}")
                    continue
                if kind == "final":
                    self.last_final = seg_id
                if text:
                    log(f"[{kind}] {text}")
                    try:
                        await self.ws.send(json.dumps({"type": kind, "text": text}))
                    except Exception:
                        return

    async def run(self):
        segmenter = Segmenter()
        worker = asyncio.create_task(self.worker())
        try:
            await self.ws.send(json.dumps({
                "type": "ready", "engine": self.engine.name,
                "model": self.engine.model_name, "device": self.engine.device_label,
            }))
            async for message in self.ws:
                if isinstance(message, str):
                    try:
                        data = json.loads(message)
                    except ValueError:
                        continue
                    if data.get("type") == "config":
                        self.language = data.get("language") or None
                        self.want_interim = bool(data.get("interim", True))
                    continue
                pcm = np.frombuffer(message, dtype=np.int16).astype(np.float32) / 32768.0
                for event in segmenter.feed(pcm):
                    self.submit(event)
            for event in segmenter.flush():
                self.submit(event)
            # let any queued final results go out before closing
            while not self.finals.empty():
                await asyncio.sleep(0.05)
        finally:
            worker.cancel()


# --------------------------------------------------------------------------
# One WebSocket connection (engines that stream text themselves)
# --------------------------------------------------------------------------
class StreamSession:
    def __init__(self, ws, engine):
        self.ws = ws
        self.engine = engine
        self.language = None
        self.want_interim = True

    async def run(self):
        loop = asyncio.get_running_loop()
        out = asyncio.Queue()
        pool = ThreadPoolExecutor(max_workers=1)  # keeps audio in order

        def emit(kind, text):
            text = (text or "").strip()
            if not text or (kind == "interim" and not self.want_interim):
                return
            loop.call_soon_threadsafe(out.put_nowait, (kind, text))

        async def sender():
            while True:
                kind, text = await out.get()
                log(f"[{kind}] {text}")
                try:
                    await self.ws.send(json.dumps({"type": kind, "text": text}))
                except Exception:
                    return

        sender_task = asyncio.create_task(sender())
        stream = None
        try:
            await self.ws.send(json.dumps({
                "type": "ready", "engine": self.engine.name,
                "model": self.engine.model_name, "device": self.engine.device_label,
            }))
            async for message in self.ws:
                if isinstance(message, str):
                    try:
                        data = json.loads(message)
                    except ValueError:
                        continue
                    if data.get("type") == "config":
                        self.language = data.get("language") or None
                        self.want_interim = bool(data.get("interim", True))
                    continue
                if stream is None:
                    await self.ws.send(json.dumps({"type": "status", "message": "Loading speech model..."}))
                    stream = await loop.run_in_executor(pool, self.engine.open, self.language, emit)
                pcm16 = np.frombuffer(message, dtype=np.int16)
                await loop.run_in_executor(pool, stream.feed, pcm16)
        finally:
            if stream is not None:
                try:
                    await loop.run_in_executor(pool, stream.close)
                except Exception as e:
                    log(f"Error while closing stream: {e}")
                await asyncio.sleep(0.3)
                while not out.empty():
                    await asyncio.sleep(0.05)
            sender_task.cancel()
            pool.shutdown(wait=False)


# --------------------------------------------------------------------------
# Server
# --------------------------------------------------------------------------
def parent_alive(pid):
    """True while the process that started us (Moon Curses) is still running."""
    if sys.platform == "win32":
        import ctypes
        SYNCHRONIZE, WAIT_TIMEOUT = 0x00100000, 0x102
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        result = kernel32.WaitForSingleObject(handle, 0)
        kernel32.CloseHandle(handle)
        return result == WAIT_TIMEOUT
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def start_parent_watchdog(pid):
    def watch():
        while True:
            time.sleep(2)
            if not parent_alive(pid):
                log("Moon Curses is gone, shutting down.")
                os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def build_engine(args):
    if args.engine == "whisper":
        return WhisperEngine(args.model or "small", args.device)
    if args.engine == "parakeet":
        return ParakeetEngine(args.device)
    if args.engine == "nemotron":
        return NemotronEngine(args.device)
    if args.engine == "vosk":
        return VoskEngine(args.device)
    if args.engine == "moonshine":
        return MoonshineEngine(args.device)
    raise SystemExit(f"Unknown engine: {args.engine}")


async def serve_forever(engine, host, port):
    try:
        from websockets.asyncio.server import serve  # websockets >= 13
    except ImportError:
        from websockets import serve

    session_class = StreamSession if engine.kind == "stream" else Session

    async def handler(ws):
        log("Client connected")
        try:
            await session_class(ws, engine).run()
        except Exception as e:
            log(f"Connection error: {e}")
        log("Client disconnected")

    async with serve(handler, host, port, max_size=2 ** 22):
        log(f"\nReady. Listening on ws://{host}:{port}  "
            f"(engine: {engine.name}, device: {engine.device_label})\n")
        await asyncio.Future()


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    p = argparse.ArgumentParser(description="Moon Curses local speech server")
    p.add_argument("--engine", default="whisper", choices=ENGINES)
    p.add_argument("--model", default="", help="whisper only: tiny, base, small, medium, large-v3-turbo")
    p.add_argument("--language", default="", help="language to load first (vosk, moonshine)")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--parent-pid", type=int, default=0, help="exit when this process disappears")
    args = p.parse_args()

    if args.parent_pid:
        start_parent_watchdog(args.parent_pid)

    engine = build_engine(args)
    if args.language:
        engine.preload(args.language)
    else:
        engine.preload("")
    try:
        asyncio.run(serve_forever(engine, args.host, args.port))
    except KeyboardInterrupt:
        log("Bye")


if __name__ == "__main__":
    main()
