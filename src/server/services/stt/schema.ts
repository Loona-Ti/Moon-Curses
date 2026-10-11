import { zSafe, zStringNumber } from "@/utils";
import { z } from "zod";

export enum STT_Backends {
  native = "native",
  browser = "browser",
  azure = "azure",
  deepgram = "deepgram",
  speechly = "speechly",
  whisper = "whisper",
  parakeet = "parakeet",
  nemotron = "nemotron",
  vosk = "vosk",
  moonshine = "moonshine",
}

export const zodSTT_Backends = z.nativeEnum(STT_Backends);

export const Service_STT_Schema = z.object({
  backend: zSafe(zodSTT_Backends, STT_Backends.native),
  autoStart: zSafe(z.coerce.boolean(), false),
  uwu: zSafe(z.coerce.boolean(), false),
  stopWithStream: zSafe(z.coerce.boolean(), false),
  replaceWords: zSafe(z.record(z.coerce.string(), z.coerce.string()), {}),
  replaceWordsIgnoreCase: zSafe(z.coerce.boolean(), false),
  replaceWordsPreserveCase: zSafe(z.coerce.boolean(), false),
  native: z.object({
    language_group: zSafe(z.coerce.string(), ""),
    language: zSafe(z.coerce.string(), ""),
  }).default({}),
  azure: z.object({
    device: zSafe(z.coerce.string(), "default"),
    language_group: zSafe(z.coerce.string(), ""),
    language: zSafe(z.coerce.string(), ""),
    secondary_language_group: zSafe(z.coerce.string(), ""),
    secondary_language: zSafe(z.coerce.string(), ""),
    use_secondary_language: zSafe(z.coerce.boolean(), true),
    key: zSafe(z.coerce.string(), ""),
    location: zSafe(z.coerce.string(), ""),
    profanity: zSafe(z.coerce.string(), "masked"),
    silenceTimeout: zSafe(zStringNumber(), "20"),
    interim: zSafe(z.coerce.boolean(), true),
  }).default({}),
  speechly: z.object({
    device: zSafe(z.coerce.string(), ""),
    key: zSafe(z.coerce.string(), ""),
  }).default({}),
  deepgram: z.object({
    device: zSafe(z.coerce.string(), "default"),
    language_group: zSafe(z.coerce.string(), ""),
    language: zSafe(z.coerce.string(), ""),
    tier: zSafe(z.coerce.string(), ""),
    key: zSafe(z.coerce.string(), ""),
    punctuate: zSafe(z.coerce.boolean(), true),
    profanity: zSafe(z.coerce.boolean(), true),
    interim: zSafe(z.coerce.boolean(), true),
  }).default({}),
  // shared by every local engine: Curses starts/stops the speech server itself
  localServer: z.object({
    manage: zSafe(z.coerce.boolean(), true),
    port: zSafe(z.coerce.string(), "8765"),
  }).default({}),
  whisper: z.object({
    device: zSafe(z.coerce.string(), "default"),
    // "auto" lets Whisper detect the spoken language
    language: zSafe(z.coerce.string(), "auto"),
    // tiny or small
    model: zSafe(z.coerce.string(), "small"),
    interim: zSafe(z.coerce.boolean(), true),
  }).default({}),
  parakeet: z.object({
    device: zSafe(z.coerce.string(), "default"),
    interim: zSafe(z.coerce.boolean(), true),
  }).default({}),
  nemotron: z.object({
    device: zSafe(z.coerce.string(), "default"),
    language: zSafe(z.coerce.string(), "auto"),
    interim: zSafe(z.coerce.boolean(), true),
  }).default({}),
  vosk: z.object({
    device: zSafe(z.coerce.string(), "default"),
    language: zSafe(z.coerce.string(), "en-us"),
    interim: zSafe(z.coerce.boolean(), true),
  }).default({}),
  moonshine: z.object({
    device: zSafe(z.coerce.string(), "default"),
    language: zSafe(z.coerce.string(), "en"),
    interim: zSafe(z.coerce.boolean(), true),
  }).default({}),
}).default({});

export type STT_State = z.infer<typeof Service_STT_Schema>;
