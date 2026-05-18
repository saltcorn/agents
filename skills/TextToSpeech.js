const { getState } = require("@saltcorn/data/db/state");
const File = require("@saltcorn/data/models/file");

class TextToSpeech {
  static skill_name = "Text to speech";

  get skill_label() {
    return "Text to speech";
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  static async configFields() {
    return [
      {
        name: "voice",
        label: "Voice",
        type: "String",
        required: true,
        attributes: {
          options: [
            "alloy",
            "ash",
            "ballad",
            "coral",
            "echo",
            "fable",
            "nova",
            "onyx",
            "sage",
            "shimmer",
            "verse",
          ],
        },
        default: "nova",
      },
      {
        name: "speed",
        label: "Speed",
        type: "Float",
        attributes: { min: 0.25, max: 4, decimal_places: 2 },
        default: 1.0,
      },
      {
        name: "format",
        label: "Audio format",
        type: "String",
        attributes: { options: ["mp3", "opus", "aac", "flac", "wav"] },
        default: "mp3",
      },
      {
        name: "instructions",
        label: "Voice instructions",
        type: "String",
        fieldview: "textarea",
        sublabel:
          "Optional. Only used with gpt-4o-mini-tts. E.g. 'Speak slowly and friendly.'",
      },
    ];
  }

  // Server-side synthesis helper, called from agent-view.js tts route
  // (not exposed as an LLM tool — the agent UI generates audio for the
  // verbatim final assistant text after each response).
  async synthesize(text, req) {
    const fn = getState().functions.llm_text_to_speech;
    if (!fn)
      throw new Error(
        "LLM plugin does not provide llm_text_to_speech (please update @saltcorn/large-language-model to >= 1.1.0)",
      );
    if (!text || !text.trim()) throw new Error("No text to speak.");
    const result = await fn.run(text, {
      voice: this.voice,
      speed: this.speed,
      response_format: this.format,
      instructions: this.instructions,
    });
    const ext = result?.output_format || this.format || "mp3";
    const mime = ext === "mp3" ? "audio/mpeg" : `audio/${ext}`;
    const file = await File.from_contents(
      `tts.${ext}`,
      mime,
      result.buffer,
      req?.user?.id,
      100,
    );
    return { filename: file.path_to_serve };
  }
}

module.exports = TextToSpeech;
