const { getState } = require("@saltcorn/data/db/state");
const File = require("@saltcorn/data/models/file");

class GenerateImage {
  static skill_name = "Image generation";

  get skill_label() {
    return "Image generation";
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  static async configFields() {
    return [
      {
        name: "size",
        label: "Size",
        type: "String",
        required: true,
        attributes: {
          options: [
            "auto",
            "1024x1024",
            "1536x1024",
            "1024x1536",
            "1792x1024",
            "1024x1792",
          ],
        },
        default: "auto",
      },
      {
        name: "quality",
        label: "Quality",
        type: "String",
        required: true,
        attributes: {
          options: ["auto", "low", "medium", "high", "standard", "hd"],
        },
        default: "auto",
      },
      {
        name: "format",
        label: "Format",
        type: "String",
        required: true,
        attributes: { options: ["png", "jpeg", "webp"] },
        default: "png",
      },
      {
        name: "transparent",
        label: "Transparent background",
        type: "Bool",
        sublabel: "Only supported with gpt-image-1.",
      },
    ];
  }

  provideTools() {
    const skill = this;
    return {
      type: "function",
      function: {
        name: "generate_image",
        description:
          "Generate an image from a text prompt. The image is automatically " +
          "displayed to the user in the chat — DO NOT include the image URL or " +
          "any markdown image syntax in your reply. Just confirm in words what " +
          "was generated.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Detailed description of the image to generate.",
            },
          },
          required: ["prompt"],
        },
      },
      process: async (input, { req }) => {
        const fn = getState().functions.llm_image_generate;
        if (!fn)
          throw new Error(
            "LLM plugin not available (llm_image_generate not registered)",
          );
        const opts = {};
        if (skill.size && skill.size !== "auto") opts.size = skill.size;
        if (skill.quality && skill.quality !== "auto")
          opts.quality = skill.quality;
        if (skill.format) opts.output_format = skill.format;
        if (skill.transparent) opts.background = "transparent";
        // gpt-image-* family supports the rich options above (quality, format,
        // background). The LLM-plugin's image gen will pick them up.
        const result = await fn.run(input.prompt, opts);
        const b64 = result?.b64_json;
        if (!b64) throw new Error("Image generation returned no data");
        const ext = result?.output_format || skill.format || "png";
        const buf = Buffer.from(b64, "base64");
        const file = await File.from_contents(
          `genimg.${ext}`,
          `image/${ext}`,
          buf,
          req?.user?.id,
          100,
        );
        const sizeOut =
          skill.size && skill.size !== "auto" ? skill.size : "1024x1024";
        // Two response paths:
        //   - add_response: rendered HTML the user actually sees in chat
        //     (with download overlay). Saved in interactions.
        //   - return shape consumed by the LLM tool_response — kept terse
        //     and free of any URL so the model cannot leak a broken markdown
        //     image link into its textual reply.
        return {
          ok: true,
          message:
            "Image generated and displayed to the user. Do NOT include the image URL or any markdown image syntax in your textual reply.",
          // Hidden internal fields used only by renderToolResponse:
          filename: file.path_to_serve,
          output_format: ext,
          size: sizeOut,
        };
      },
      renderToolResponse: (v) => {
        const sz = v?.size || "1024x1024";
        const [ws, hs] = sz.split("x");
        const w = +ws / 4;
        const h = +hs / 4;
        if (!v?.filename) return "";
        const ext = v.output_format || "png";
        const url = "/files/serve/" + v.filename;
        const dlName = "image-" + Date.now() + "." + ext;
        return (
          `<div class="agent-generated-image">` +
          `<img height="${h}" width="${w}" src="${url}" />` +
          `<a href="${url}" download="${dlName}" ` +
          `class="agent-image-download" title="Download image">` +
          `<i class="fas fa-download"></i></a>` +
          `</div>`
        );
      },
    };
  }
}

module.exports = GenerateImage;
