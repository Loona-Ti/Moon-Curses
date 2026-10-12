import { IServiceInterface, TextEventSource, TextEventType } from "@/types";

/**
 * Fansly chat bridge.
 * When enabled, every final speech-to-text result is broadcast on the topic "fansly.chat"
 * through Curses' local websocket (ws://127.0.0.1:<port>/pubsub).
 * The "Moon Curses → Fansly" Chrome extension listens to that topic and types the text into the Fansly chat.
 */
class Service_Fansly implements IServiceInterface {
  get #state() {
    return window.ApiServer.state.services.fansly;
  }

  async init() {
    window.ApiShared.pubsub.subscribeText(TextEventSource.stt, (data) => {
      if (!this.#state.data.enable) return;
      if (data?.type !== TextEventType.final || !data.value?.trim()) return;
      window.ApiShared.pubsub.publish("fansly.chat", {
        type: TextEventType.final,
        value: data.value.trim(),
      });
    });
  }
}

export default Service_Fansly;
