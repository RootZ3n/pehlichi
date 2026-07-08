/**
 * MUSIC TOOLS — agent-facing surface over MiniMax Music 2.6 API.
 *
 * Three tools that let the trio generate music, lyrics, and covers:
 *   - music_generate : generate a song from style prompt + lyrics (or instrumental).
 *   - music_lyrics   : auto-generate lyrics from a theme description.
 *   - music_cover    : generate a cover of an existing audio in a new style.
 *
 * Uses MiniMax Music 2.6 API. Supports free tier (music-2.6-free) and paid tier.
 * API key resolved from MINIMAX_API_KEY env var.
 */
import type { ToolSpec, ToolHandler, ToolResult } from "../tools.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

const API_BASE = "https://api.minimax.io/v1";

/** Resolve MiniMax API key from env. */
function apiKey(): string | undefined {
  return process.env["MINIMAX_API_KEY"]?.trim() || undefined;
}

/** Default output directory for generated music. */
const DEFAULT_OUTPUT_DIR = "/tmp/music-output";

/** Music generation timeout — songs can take up to 2 minutes. */
const MUSIC_TIMEOUT_MS = 600_000; // 10 minutes

export const musicToolSpecs: ToolSpec[] = [
  {
    name: "music_generate",
    description:
      "Generate a song using MiniMax Music 2.6. Provide a style prompt and lyrics, " +
      "or use instrumental mode for music without vocals. Returns the output file path.",
    parameters: obj(
      {
        prompt: {
          type: "string",
          description:
            "Music style, mood, and scenario description. " +
            "Examples: '8-bit chiptune RPG theme, NES style, adventurous' or " +
            "'Janky cartoon comedy, banjo and trombone, chaotic energy'. Max 2000 chars.",
        },
        lyrics: {
          type: "string",
          description:
            "Song lyrics with structure tags like [Verse], [Chorus], [Bridge], [Intro], [Outro]. " +
            "Required unless instrumental=true or lyrics_optimizer=true. Max 3500 chars.",
        },
        instrumental: {
          type: "boolean",
          description: "Generate instrumental music with no vocals (default: false).",
        },
        lyrics_optimizer: {
          type: "boolean",
          description: "Auto-generate lyrics from the style prompt (default: false).",
        },
        output_path: {
          type: "string",
          description: "Output file path (default: /tmp/music-output/<name>.mp3).",
        },
        free_tier: {
          type: "boolean",
          description: "Use free tier model music-2.6-free (lower priority, same quality). Default: true.",
        },
        sample_rate: {
          type: "number",
          description: "Audio sample rate in Hz (default: 44100).",
        },
      },
      ["prompt"],
    ),
  },
  {
    name: "music_lyrics",
    description:
      "Generate song lyrics from a theme description using MiniMax's lyrics generation API. " +
      "Returns structured lyrics with [Verse], [Chorus], [Bridge] tags.",
    parameters: obj(
      {
        theme: {
          type: "string",
          description:
            "Theme or concept for the lyrics. " +
            "Examples: 'A heroic quest through digital lands' or 'Wacky worms causing chaos'.",
        },
      },
      ["theme"],
    ),
  },
  {
    name: "music_cover",
    description:
      "Generate a cover of an existing audio file in a new musical style. " +
      "Takes a reference audio file and re-imagines it in a different genre.",
    parameters: obj(
      {
        audio_path: {
          type: "string",
          description: "Path to the reference audio file (mp3, wav, flac). 6s-6min, ≤50MB.",
        },
        prompt: {
          type: "string",
          description: "Target style for the cover. Example: '8-bit chiptune version' or 'orchestral arrangement'.",
        },
        lyrics: {
          type: "string",
          description: "Optional modified lyrics for the cover (10-1000 chars). If omitted, extracted from audio.",
        },
        output_path: {
          type: "string",
          description: "Output file path (default: /tmp/music-output/cover.mp3).",
        },
        free_tier: {
          type: "boolean",
          description: "Use free tier model (default: true).",
        },
      },
      ["audio_path", "prompt"],
    ),
  },
];

/** POST to MiniMax API with timeout + error handling. */
async function minimaxRequest(
  tool: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const key = apiKey();
  if (!key) {
    return { ok: false, error: `${tool}: MINIMAX_API_KEY not set. Add to environment or ~/bok.` };
  }

  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "authorization": `Bearer ${key}`,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MUSIC_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, error: `${tool}: MiniMax API timed out after ${MUSIC_TIMEOUT_MS / 1000}s` };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${tool}: cannot reach MiniMax API (${detail})` };
  }

  const text = await response.text().catch(() => "");
  let data: unknown = undefined;
  if (text.length > 0) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!response.ok) {
    const serverMsg =
      data !== null && typeof data === "object" && "error" in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : typeof data === "string" && data.length > 0 ? data : response.statusText;
    return { ok: false, error: `${tool}: MiniMax returned ${response.status} ${serverMsg}`.trim() };
  }

  return { ok: true, data };
}

/** Download audio from URL and save to file. */
async function downloadAudio(url: string, outputPath: string): Promise<string> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);
  return outputPath;
}

export function createMusicToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set("music_generate", async (args): Promise<ToolResult> => {
    const prompt = (args.prompt as string)?.trim();
    if (!prompt) return { ok: false, output: "", error: "music_generate requires a prompt (style description)" };

    const lyrics = (args.lyrics as string)?.trim() || "";
    const instrumental = args.instrumental === true;
    const lyricsOptimizer = args.lyrics_optimizer === true;
    const freeTier = args.free_tier !== false; // default true
    const sampleRate = typeof args.sample_rate === "number" ? args.sample_rate : 44100;

    if (!instrumental && !lyrics && !lyricsOptimizer) {
      return {
        ok: false,
        output: "",
        error: "music_generate requires lyrics, instrumental=true, or lyrics_optimizer=true",
      };
    }

    const model = freeTier ? "music-2.6-free" : "music-2.6";

    const payload: Record<string, unknown> = {
      model,
      prompt,
      audio_setting: { sample_rate: sampleRate, bitrate: 256000, format: "mp3" },
      output_format: "url",
    };

    if (instrumental) {
      payload.is_instrumental = true;
    } else if (lyrics) {
      payload.lyrics = lyrics;
    } else {
      payload.lyrics_optimizer = true;
    }

    const outputPath = (args.output_path as string)?.trim() ||
      `${DEFAULT_OUTPUT_DIR}/music_${Date.now()}.mp3`;

    const res = await minimaxRequest("music_generate", "/music_generation", payload);
    if (!res.ok) return { ok: false, output: "", error: res.error };

    const data = res.data as Record<string, unknown>;
    const baseResp = data.base_resp as Record<string, unknown> | undefined;
    if (baseResp?.status_code !== 0) {
      return {
        ok: false,
        output: "",
        error: `music_generate: MiniMax error ${baseResp?.status_code}: ${baseResp?.status_msg}`,
      };
    }

    const audioUrl = (data.data as Record<string, unknown>)?.audio as string;
    const extra = data.extra_info as Record<string, unknown> | undefined;
    const durationMs = (extra?.music_duration as number) || 0;
    const durationSec = durationMs / 1000;

    if (!audioUrl) {
      return { ok: false, output: "", error: "music_generate: no audio URL in response" };
    }

    try {
      const savedPath = await downloadAudio(audioUrl, outputPath);
      return {
        ok: true,
        output: [
          `Music generated: ${savedPath}`,
          `  Duration: ${durationSec.toFixed(1)}s`,
          `  Style: ${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}`,
          `  Mode: ${instrumental ? "instrumental" : "with vocals"}`,
          `  Tier: ${freeTier ? "free" : "paid"}`,
        ].join("\n"),
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, output: "", error: `music_generate: download failed (${detail})` };
    }
  });

  handlers.set("music_lyrics", async (args): Promise<ToolResult> => {
    const theme = (args.theme as string)?.trim();
    if (!theme) return { ok: false, output: "", error: "music_lyrics requires a theme" };

    const res = await minimaxRequest("music_lyrics", "/lyrics_generation", {
      mode: "write_full_song",
      prompt: theme,
    });
    if (!res.ok) return { ok: false, output: "", error: res.error };

    const data = res.data as Record<string, unknown>;
    const baseResp = data.base_resp as Record<string, unknown> | undefined;
    if (baseResp?.status_code !== 0) {
      return {
        ok: false,
        output: "",
        error: `music_lyrics: MiniMax error ${baseResp?.status_code}: ${baseResp?.status_msg}`,
      };
    }

    const lyrics = (data.data as Record<string, unknown>)?.lyrics as string || "";
    return {
      ok: true,
      output: `Generated lyrics for theme: "${theme}"\n\n${lyrics}`,
    };
  });

  handlers.set("music_cover", async (args): Promise<ToolResult> => {
    const audioPath = (args.audio_path as string)?.trim();
    if (!audioPath) return { ok: false, output: "", error: "music_cover requires audio_path" };

    const prompt = (args.prompt as string)?.trim();
    if (!prompt) return { ok: false, output: "", error: "music_cover requires a prompt (target style)" };

    const lyrics = (args.lyrics as string)?.trim() || "";
    const freeTier = args.free_tier !== false;

    // Read and encode audio
    let audioBase64: string;
    try {
      const { readFile } = await import("node:fs/promises");
      const buffer = await readFile(audioPath);
      audioBase64 = buffer.toString("base64");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, output: "", error: `music_cover: cannot read audio file (${detail})` };
    }

    const model = freeTier ? "music-cover-free" : "music-cover";

    const payload: Record<string, unknown> = {
      model,
      audio_base64: audioBase64,
      prompt,
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
      output_format: "url",
    };
    if (lyrics) payload.lyrics = lyrics;

    const outputPath = (args.output_path as string)?.trim() ||
      `${DEFAULT_OUTPUT_DIR}/cover_${Date.now()}.mp3`;

    const res = await minimaxRequest("music_cover", "/music_generation", payload);
    if (!res.ok) return { ok: false, output: "", error: res.error };

    const data = res.data as Record<string, unknown>;
    const baseResp = data.base_resp as Record<string, unknown> | undefined;
    if (baseResp?.status_code !== 0) {
      return {
        ok: false,
        output: "",
        error: `music_cover: MiniMax error ${baseResp?.status_code}: ${baseResp?.status_msg}`,
      };
    }

    const audioUrl = (data.data as Record<string, unknown>)?.audio as string;
    if (!audioUrl) {
      return { ok: false, output: "", error: "music_cover: no audio URL in response" };
    }

    try {
      const savedPath = await downloadAudio(audioUrl, outputPath);
      return {
        ok: true,
        output: `Cover generated: ${savedPath}\n  Style: ${prompt}\n  Source: ${audioPath}`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, output: "", error: `music_cover: download failed (${detail})` };
    }
  });

  return handlers;
}
