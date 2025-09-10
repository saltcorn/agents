const { getState } = require("@saltcorn/data/db/state");
const { div, span } = require("@saltcorn/markup/tags");
const Trigger = require("@saltcorn/data/models/trigger");
const { interpolate } = require("@saltcorn/data/utils");
const db = require("@saltcorn/data/db");

const MarkdownIt = require("markdown-it"),
  md = new MarkdownIt();

const nubBy = (f, xs) => {
  const vs = new Set();
  return xs.filter((x) => {
    const y = f(x);
    if (vs.has(y)) return false;
    vs.add(y);
    return true;
  });
};

const get_skills = () => {
  const state = getState();
  const exchange_skills = nubBy(
    (c) => c.constructor.name,
    state.exchange?.agent_skills || []
  );

  return [
    require("./skills/FTSRetrieval"),
    require("./skills/EmbeddingRetrieval"),
    require("./skills/Trigger"),
    require("./skills/Table"),
    require("./skills/PreloadData"),
    require("./skills/GenerateImage"),
    require("./skills/ModelContextProtocol"),
    //require("./skills/AdaptiveFeedback"),
    ...exchange_skills,
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
    const found = tools.find((t) => t?.function?.name === name);
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

const get_initial_interactions = async (config, user, triggering_row) => {
  const interacts = [];
  const skills = get_skill_instances(config);
  for (const skill of skills) {
    const its = await skill.initialInteractions?.({ user, triggering_row });
    if (its) interacts.push(...its);
  }
  return interacts;
};

const getCompletionArguments = async (config, user, triggering_row) => {
  let tools = [];

  let sysPrompts = [
    interpolate(config.sys_prompt, triggering_row || {}, user, "System prompt"),
  ];

  const skills = get_skill_instances(config);
  for (const skill of skills) {
    const sysPr = await skill.systemPrompt?.({ user, triggering_row });
    if (sysPr) sysPrompts.push(sysPr);
    const skillTools = skill.provideTools?.();
    if (skillTools && Array.isArray(skillTools)) tools.push(...skillTools);
    else if (skillTools) tools.push(skillTools);
  }
  if (tools.length === 0) tools = undefined;
  const complArgs = { tools, systemPrompt: sysPrompts.join("\n\n") };
  if (config.model) complArgs.model = config.model;
  return complArgs;
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

const only_response_text_if_present = (interact) => {
  if (
    interact.role === "tool" &&
    interact.call_id &&
    interact.content?.[0] === "{"
  ) {
    try {
      const result = JSON.parse(interact.content);
      if (result.responseText)
        return { ...interact, content: result.responseText };
    } catch {
      //ignore, not json content
    }
  }
  return interact;
};

const is_debug_mode = (config, user) => user?.role_id === 1;

const process_interaction = async (
  run,
  config,
  req,
  agent_label = "Copilot",
  prevResponses = [],
  triggering_row = {},
  stream = false
) => {
  const sysState = getState();
  const complArgs = await getCompletionArguments(
    config,
    req.user,
    triggering_row
  );
  complArgs.chat = run.context.interactions.map(only_response_text_if_present);
  //complArgs.debugResult = true;
  //console.log("complArgs", JSON.stringify(complArgs, null, 2));
  const debugMode = is_debug_mode(config, req.user);
  const debugCollector = {};
  if (debugMode) complArgs.debugCollector = debugCollector;
  if (stream && sysState.getConfig("enable_dynamic_updates") && req.user) {
    complArgs.streamCallback = (response) => {
      const content =
        response.choices[0].content || response.choices[0].delta?.content;
      if (content)
        sysState?.emitDynamicUpdate(
          db.getTenantSchema(),
          {
            eval_js: `$('form.agent-view div.next_response_scratch').append(${JSON.stringify(
              content
            )})`,
          },
          [req.user.id]
        );
    };
  }
  const answer = await sysState.functions.llm_generate.run("", complArgs);

  if (debugMode)
    await addToContext(run, {
      api_interactions: [debugCollector],
    });
  const responses = [];
  if (answer && typeof answer === "object" && answer.image_calls) {
    for (const image_call of answer.image_calls) {
      const tool = find_image_tool(config);
      let prcRes;
      if (tool?.tool.process) {
        prcRes = await tool.tool.process(image_call, { req });
        if (prcRes?.result === null) delete image_call.result;
        if (prcRes?.filename) image_call.filename = prcRes?.filename;
      }
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
  if (
    answer &&
    typeof answer === "object" &&
    (answer.tool_calls || answer.mcp_calls)
  ) {
    if (answer.content)
      responses.push(wrapSegment(md.render(answer.content), agent_label));
    //const actions = [];
    let hasResult = false;
    if ((answer.mcp_calls || []).length && !answer.content) hasResult = true;
    for (const tool_call of answer.tool_calls || []) {
      console.log("call function", tool_call.function?.name);

      await addToContext(run, {
        funcalls: { [tool_call.id]: tool_call.function },
      });

      const tool = find_tool(tool_call.function?.name, config);

      if (tool) {
        if (
          stream &&
          sysState.getConfig("enable_dynamic_updates") &&
          req.user
        ) {
          let content =
            "Using skill: " + tool.skill.skill_label ||
            tool.skill.constructor.skill_name;
          sysState?.emitDynamicUpdate(
            db.getTenantSchema(),
            {
              eval_js: `$('form.agent-view div.next_response_scratch').append(${JSON.stringify(
                content
              )})`,
            },
            [req.user.id]
          );
        }
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
      return await process_interaction(
        run,
        config,
        req,
        agent_label,
        [...prevResponses, ...responses],
        triggering_row,
        stream
      );
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
  find_tool,
  get_skill_instances,
  getCompletionArguments,
  addToContext,
  wrapCard,
  wrapSegment,
  process_interaction,
  find_image_tool,
  is_debug_mode,
  get_initial_interactions,
  nubBy,
};
