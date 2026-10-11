import { STT_LocalServerService } from "./local_server";
import { STT_State } from "../schema";

/** Local Whisper (tiny or small). Runs on the GPU when available. */
export class STT_WhisperService extends STT_LocalServerService {
  protected engine = "whisper";
  protected label = "Whisper";
  protected settings(state: STT_State) {
    return { ...state.whisper };
  }
}
