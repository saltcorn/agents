const path = require("path");
const fs = require("fs").promises;

class ExternalSkill {
  static skill_name = "External Skill (SKILL.md)";

  get skill_label() {
    return "External Skill";
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  static async configFields() {
    return [
      {
        name: "skills_dir",
        label: "Skill directory",
        type: "String",
        required: true,
        sublabel: "Path to the directory containing SKILL.md",
      },
    ];
  }

  async systemPrompt() {
    if (!this.skills_dir) return;
    const skillMdPath = path.join(this.skills_dir, "SKILL.md");
    try {
      return await fs.readFile(skillMdPath, "utf8");
    } catch (e) {
      return `[ExternalSkill: could not read ${skillMdPath}: ${e.message}]`;
    }
  }
}

module.exports = ExternalSkill;
