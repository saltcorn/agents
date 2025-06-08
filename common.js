const { getState } = require("@saltcorn/data/db/state");

const get_skills = () => {
  return [require("./skills/RAG"), require("./skills/AdaptiveFeedback")];
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
  incompleteCfgMsg,
  getCompletion,
};
