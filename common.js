const { getState } = require("@saltcorn/data/db/state");
const { div, span } = require("@saltcorn/markup/tags");
const Trigger = require("@saltcorn/data/models/trigger");

const MarkdownIt = require("markdown-it"),
  md = new MarkdownIt();

const get_skills = () => {
  return [
    require("./skills/FTSRetrieval"),
    require("./skills/EmbeddingRetrieval"),
    require("./skills/Trigger"),
    require("./skills/Table"),
    require("./skills/PreloadData"),
    require("./skills/GenerateImage"),
    //require("./skills/AdaptiveFeedback"),
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
    const skillTools = skill.provideTools?.();
    const tools = !skillTools
      ? []
      : Array.isArray(skillTools)
      ? skillTools
      : [skillTools];
    const found = tools.find((t) => t?.function.name === name);
    if (found) return { tool: found, skill };
  }
};

const find_image_tool = (config) => {
  const skills = get_skill_instances(config);
  for (const skill of skills) {
    const skillTools = skill.provideTools?.();
    const tools = !skillTools
      ? []
      : Array.isArray(skillTools)
      ? skillTools
      : [skillTools];
    const found = tools.find((t) => t?.type === "image_generation");
    if (found) return { tool: found, skill };
  }
};

const getCompletionArguments = async (config, user) => {
  let tools = [];

  let sysPrompts = [config.sys_prompt];

  const skills = get_skill_instances(config);
  for (const skill of skills) {
    const sysPr = await skill.systemPrompt?.({ user });
    if (sysPr) sysPrompts.push(sysPr);
    const skillTools = skill.provideTools?.();
    if (skillTools && Array.isArray(skillTools)) tools.push(...skillTools);
    else if (skillTools) tools.push(skillTools);
  }
  if (tools.length === 0) tools = undefined;
  return { tools, systemPrompt: sysPrompts.join("\n\n") };
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

const addToContext = async (run, newCtx) => {
  if (run.addToContext) return await run.addToContext(newCtx);
  let changed = true;
  Object.keys(newCtx).forEach((k) => {
    if (Array.isArray(run.context[k])) {
      if (!Array.isArray(newCtx[k]))
        throw new Error("Must be array to append to array");
      run.context[k].push(...newCtx[k]);
      changed = true;
    } else if (typeof run.context[k] === "object") {
      if (typeof newCtx[k] !== "object")
        throw new Error("Must be object to append to object");
      Object.assign(run.context[k], newCtx[k]);
      changed = true;
    } else {
      run.context[k] = newCtx[k];
      changed = true;
    }
  });
  if (changed) await run.update({ context: run.context });
};

const wrapSegment = (html, who) =>
  '<div class="interaction-segment"><span class="badge bg-secondary">' +
  who +
  "</span>" +
  html +
  "</div>";

const wrapCard = (title, ...inners) =>
  span({ class: "badge bg-info ms-1" }, title) +
  div(
    { class: "card mb-3 bg-secondary-subtle" },
    div({ class: "card-body" }, inners)
  );

const process_interaction = async (
  run,
  config,
  req,
  agent_label = "Copilot",
  prevResponses = []
) => {
  const complArgs = await getCompletionArguments(config, req.user);
  complArgs.chat = run.context.interactions;
  //complArgs.debugResult = true;
  console.log("complArgs", JSON.stringify(complArgs, null, 2));

  const answer = await getState().functions.llm_generate.run("", complArgs);
  console.log("answer", answer);
  await addToContext(run, {
    interactions:
      typeof answer === "object" && answer.tool_calls
        ? [
            {
              role: "assistant",
              tool_calls: answer.tool_calls,
              content: answer.content,
            },
          ]
        : [{ role: "assistant", content: answer }],
  });
  const responses = [];
  if (typeof answer === "object" && answer.image_calls) {
    for (const image_call of answer.image_calls) {
      const tool = find_image_tool(config);
      let prcRes;
      if (tool?.tool.process)
        prcRes = await tool.tool.process(image_call, { req });
      if (tool?.tool.renderToolResponse) {
        const rendered = await tool.tool.renderToolResponse(
          { ...image_call, ...(prcRes || {}) },
          {
            req,
          }
        );
        if (rendered)
          responses.push(
            wrapSegment(
              wrapCard(
                tool.skill.skill_label || tool.skill.constructor.skill_name,
                rendered
              ),
              agent_label
            )
          );
      }
    }
    if (answer.content && !answer.tool_calls)
      responses.push(wrapSegment(md.render(answer.content), agent_label));
  }
  if (typeof answer === "object" && answer.tool_calls) {
    if (answer.content)
      responses.push(wrapSegment(md.render(answer.content), agent_label));
    //const actions = [];
    let hasResult = false;
    for (const tool_call of answer.tool_calls) {
      console.log("call function", tool_call.function);

      await addToContext(run, {
        funcalls: { [tool_call.id]: tool_call.function },
      });

      const tool = find_tool(tool_call.function.name, config);

      if (tool) {
        if (tool.tool.renderToolCall) {
          const row = JSON.parse(tool_call.function.arguments);
          const rendered = await tool.tool.renderToolCall(row, {
            req,
          });
          if (rendered)
            responses.push(
              wrapSegment(
                wrapCard(
                  tool.skill.skill_label || tool.skill.constructor.skill_name,
                  rendered
                ),
                agent_label
              )
            );
        }
        hasResult = true;
        const result = await tool.tool.process(
          JSON.parse(tool_call.function.arguments),
          { req }
        );
        if (
          (typeof result === "object" && Object.keys(result || {}).length) ||
          typeof result === "string"
        ) {
          if (tool.tool.renderToolResponse) {
            const rendered = await tool.tool.renderToolResponse(result, {
              req,
            });
            if (rendered)
              responses.push(
                wrapSegment(
                  wrapCard(
                    tool.skill.skill_label || tool.skill.constructor.skill_name,
                    rendered
                  ),
                  agent_label
                )
              );
          }
          hasResult = true;
        }
        await addToContext(run, {
          interactions: [
            {
              role: "tool",
              tool_call_id: tool_call.id,
              call_id: tool_call.call_id,
              name: tool_call.function.name,
              content:
                result && typeof result !== "string"
                  ? JSON.stringify(result)
                  : result || "Action run",
            },
          ],
        });
      }
    }
    if (hasResult)
      return await process_interaction(run, config, req, agent_label, [
        ...prevResponses,
        ...responses,
      ]);
  } else if (typeof answer === "string")
    responses.push(wrapSegment(md.render(answer), agent_label));

  return {
    json: {
      success: "ok",
      response: [...prevResponses, ...responses].join(""),
      run_id: run.id,
    },
  };
};

module.exports = {
  get_skills,
  get_skill_class,
  incompleteCfgMsg,
  getCompletion,
  find_tool,
  get_skill_instances,
  getCompletionArguments,
  addToContext,
  wrapCard,
  wrapSegment,
  process_interaction,
};
