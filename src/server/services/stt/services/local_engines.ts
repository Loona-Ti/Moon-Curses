import { STT_LocalServerService } from "./local_server";
import { STT_State } from "../schema";

/** NVIDIA Parakeet TDT 0.6B v3 (25 European languages, detected automatically). */
export class STT_ParakeetService extends STT_LocalServerService {
  protected engine = "parakeet";
  protected label = "Parakeet";
  protected settings(state: STT_State) {
    return { ...state.parakeet, language: "auto" };
  }
}

/** NVIDIA Nemotron Speech Streaming. */
export class STT_NemotronService extends STT_LocalServerService {
  protected engine = "nemotron";
  protected label = "Nemotron";
  protected settings(state: STT_State) {
    return { ...state.nemotron };
  }
}

/** Vosk: very light, runs on the CPU. */
export class STT_VoskService extends STT_LocalServerService {
  protected engine = "vosk";
  protected label = "Vosk";
  protected settings(state: STT_State) {
    return { ...state.vosk };
  }
}

/** Moonshine: small, fast, runs on the CPU. */
export class STT_MoonshineService extends STT_LocalServerService {
  protected engine = "moonshine";
  protected label = "Moonshine";
  protected settings(state: STT_State) {
    return { ...state.moonshine };
  }
}
