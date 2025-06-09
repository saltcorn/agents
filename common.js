const { getState } = require("@saltcorn/data/db/state");

const get_skills = () => {
  return [
    require("./skills/EmbeddingRetrival"),
    require("./skills/FTSRetrival"),
    require("./skills/AdaptiveFeedback"),
  ];
};

const get_skill_class = (type) => {
  const classes = get_skills();
  return classes.find((c) => c.skill_name === type);
};

const get_skill_instances = (config) => {
  const instances = [];
  for (const skillCfg of config.skills) {
    const klass = get_skill_class(skillCfg.skill_type);
    const skill = new klass(skillCfg);
    instances.push(skill);
  }
  return instances;
};

const find_tool = (name, config) => {
  const skills = get_skill_instances(config);
  for (const skill of skills) {
    const skillTools = skill.provideTools();
    const tools = !skillTools
      ? []
      : Array.isArray(skillTools)
      ? skillTools
      : [skillTools];
    const found = tools.find((t) => t?.function.name === name);
    if (found) return { tool: found, skill };
  }
};

const getCompletion = async (language, prompt) => {
  return getState().functions.llm_generate.run(prompt, {
    systemPrompt: `You are a helpful code assistant. Your language of choice is ${language}. Do not include any explanation, just generate the code block itself.`,
  });
};

const incompleteCfgMsg = () => {
  const plugin_cfgs = getState().plugin_cfgs;

  if (
    !plugin_cfgs["@saltcorn/large-language-model"] &&
    !plugin_cfgs["large-language-model"]
  ) {
    const modName = Object.keys(plugin_cfgs).find((m) =>
      m.includes("large-language-model")
    );
    if (modName)
      return `LLM module not configured. Please configure <a href="/plugins/configure/${encodeURIComponent(
        modName
      )}">here<a> before using copilot.`;
    else
      return `LLM module not configured. Please install and configure <a href="/plugins">here<a> before using copilot.`;
  }
};

module.exports = {
  get_skills,
  get_skill_class,
  incompleteCfgMsg,
  getCompletion,
  find_tool,
  get_skill_instances,
};
