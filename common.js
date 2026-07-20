const { getState } = require("@saltcorn/data/db/state");
const { div, span, button } = require("@saltcorn/markup/tags");
const Trigger = require("@saltcorn/data/models/trigger");
const View = require("@saltcorn/data/models/view");
const { interpolate } = require("@saltcorn/data/utils");
const db = require("@saltcorn/data/db");
const WorkflowRun = require("@saltcorn/data/models/workflow_run");

const MarkdownIt = require("markdown-it"),
  md = new MarkdownIt({ html: true, breaks: true, linkify: true });

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
    (c) => c.skill_name,
    state.exchange?.agent_skills || [],
  );

  return [
    require("./skills/FTSRetrieval"),
    require("./skills/EmbeddingRetrieval"),
    require("./skills/Trigger"),
    require("./skills/Table"),
    require("./skills/PreloadData"),
    require("./skills/GenerateImage"),
    require("./skills/TextToSpeech"),
    require("./skills/ModelContextProtocol"),
    require("./skills/PromptPicker"),
    require("./skills/ModelPicker"),
    require("./skills/RunJsCode"),
    require("./skills/GenerateAndRunJsCode"),
    require("./skills/Fetch"),
    require("./skills/WebSearch"),
    require("./skills/Subagent"),
    require("./skills/ExternalSkill"),
    require("./skills/PlanApproval"),
    require("./skills/LongTermMemory"),
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
    if (klass) {
      const skill = new klass(skillCfg);
      instances.push(skill);
    }
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

const getSystemPrompt = async (config, user, triggering_row, formbody) => {
  let sysPrompts = [
    interpolate(config.sys_prompt, triggering_row || {}, user, "System prompt"),
  ];

  const skills = get_skill_instances(config);
  for (const skill of skills) {
    const sysPr = await skill.systemPrompt?.({
      ...(formbody || {}),
      user,
      triggering_row,
    });
    if (sysPr) sysPrompts.push(sysPr);
  }

  return sysPrompts.join("\n\n");
};

const getCompletionArguments = async (
  config,
  user,
  triggering_row,
  formbody,
) => {
  let tools = [];

  let sysPrompts = [
    interpolate(config.sys_prompt, triggering_row || {}, user, "System prompt"),
  ];

  const skills = get_skill_instances(config);
  const overrides = {};
  for (const skill of skills) {
    const sysPr = await skill.systemPrompt?.({
      ...(formbody || {}),
      user,
      triggering_row,
    });
    const overide =
      (await skill.settingsOverride?.({
        ...(formbody || {}),
        user,
        triggering_row,
      })) || {};
    Object.assign(overrides, overide);

    if (sysPr) sysPrompts.push(sysPr);
    const skillTools = skill.provideTools?.();
    if (skillTools && Array.isArray(skillTools)) tools.push(...skillTools);
    else if (skillTools) tools.push(skillTools);
  }
  if (tools.length === 0) tools = undefined;
  const complArgs = {
    tools,
    systemPrompt: sysPrompts.join("\n\n"),
    ephemeralCacheControl: true,
  };
  if (config.model) complArgs.model = config.model;

  if (overrides.alt_config || config.alt_config)
    complArgs.alt_config = overrides.alt_config || config.alt_config;
  return complArgs;
};

const incompleteCfgMsg = () => {
  const plugin_cfgs = getState().plugin_cfgs;

  if (
    !plugin_cfgs["@saltcorn/large-language-model"] &&
    !plugin_cfgs["large-language-model"]
  ) {
    const modName = Object.keys(plugin_cfgs).find((m) =>
      m.includes("large-language-model"),
    );
    if (modName)
      return `LLM module not configured. Please configure <a href="/plugins/configure/${encodeURIComponent(
        modName,
      )}">here<a> before using copilot.`;
    else
      return `LLM module not configured. Please install and configure <a href="/plugins">here<a> before using copilot.`;
  }
};

const addToContext = async (run, newCtx) => {
  if (!run) return;
  if (run.addToContext) return await run.addToContext(newCtx);
  let changed = true;
  let extraRunSet = {};
  Object.keys(newCtx).forEach((k) => {
    if (Array.isArray(run.context[k])) {
      if (!Array.isArray(newCtx[k]))
        throw new Error("Must be array to append to array");
      if (k === "interactions") run.context[k] = newCtx[k];
      else run.context[k].push(...newCtx[k]);
      changed = true;
    } else if (typeof run.context[k] === "object") {
      if (typeof newCtx[k] !== "object")
        throw new Error("Must be object to append to object");
      Object.assign(run.context[k], newCtx[k]);
      changed = true;
    } else if (k === "status") {
      extraRunSet.status = newCtx[k];
    } else {
      run.context[k] = newCtx[k];
      changed = true;
    }
  });
  if (changed && run.update)
    await run.update({ context: run.context, ...extraRunSet });
};

const saveInteractions = async (run) => {
  await addToContext(run, {
    interactions: run.context.interactions || [],
  });
};

const wrapSegment = (html, who, to_right, layout, user) =>
  who === null
    ? html
    : layout && layout.startsWith("Modern chat")
      ? `<div class="chat-message ${to_right ? "chat-user" : "chat-assistant"}">` +
        `<div class="chat-avatar"${user ? ` title="${user.email} at ${new Date().toString()}"` : ""}><i class="fas ${to_right ? "fa-user" : "fa-robot"}"></i></div>` +
        `<div class="chat-bubble${" copy-to-clipboard-elem"}">${html}</div>` +
        `</div>`
      : `<div class="interaction-segment ${to_right ? "to-right" : ""}"><div><div class="badgewrap"><span class="badge bg-secondary">` +
        who +
        "</span></div>" +
        html +
        "</div></div>";

const wrapCard = (title, ...inners) =>
  span({ class: "badge bg-info ms-1" }, title) +
  div(
    { class: "card mb-3 bg-secondary-subtle" },
    div({ class: "card-body" }, inners),
  );

const is_debug_mode = (config, user) => user?.role_id === 1;

function extractText(html) {
  return html.replace(/<[^>]*>/g, "");
}

// Strip markdown image syntax ![alt](url) from assistant text so that the LLM
// can't leak a broken/duplicate image reference next to a tool-rendered image
// bubble. Plain links are preserved.
function stripMarkdownImages(s) {
  if (typeof s !== "string") return s;
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim();
}

const isToolResultMessage = (msg) =>
  !!msg &&
  typeof msg === "object" &&
  (msg.role === "tool" ||
    msg.type === "function_call_output" ||
    (Array.isArray(msg.content) &&
      msg.content.some(
        (part) => part?.type === "tool-result" || part?.type === "tool-error",
      )));

// Find tool calls in the chat that have no matching tool result. The shape of
// the chat depends on the LLM backend, so all the known shapes are inspected.
const pendingToolCalls = (chat) => {
  const calls = new Map(); // tool_call_id -> {tool_name, index}
  const answered = new Set();
  (chat || []).forEach((msg, index) => {
    if (!msg || typeof msg !== "object") return;

    // OpenAI responses API
    if (msg.type === "function_call" && msg.call_id)
      calls.set(msg.call_id, { tool_name: msg.name, index });
    if (msg.type === "function_call_output" && msg.call_id)
      answered.add(msg.call_id);

    // OpenAI chat completions API
    if (Array.isArray(msg.tool_calls))
      for (const tc of msg.tool_calls)
        if (tc?.id)
          calls.set(tc.id, {
            tool_name: tc.function?.name || tc.name,
            index,
          });
    if (msg.role === "tool" && msg.tool_call_id) answered.add(msg.tool_call_id);

    // AI SDK
    if (Array.isArray(msg.content))
      for (const part of msg.content) {
        if (part?.type === "tool-call" && part.toolCallId)
          calls.set(part.toolCallId, { tool_name: part.toolName, index });
        if (
          (part?.type === "tool-result" || part?.type === "tool-error") &&
          part.toolCallId
        )
          answered.add(part.toolCallId);
      }
  });
  const pending = [];
  calls.forEach(({ tool_name, index }, tool_call_id) => {
    if (!answered.has(tool_call_id))
      pending.push({ tool_call_id, tool_name, index });
  });
  return pending;
};

// Guarantee that every tool call in the chat has a tool result. A tool call
// without a result makes every subsequent LLM interaction fail, so any call
// that was not answered - because the tool no longer exists, because a skill
// requested a stop, or because processing errored - gets a synthetic result.
const ensureToolResults = async (
  run,
  message = "The tool call was not completed.",
) => {
  const chat = run.context.interactions;
  if (!Array.isArray(chat)) return false;
  let repaired = false;
  // one call is repaired per pass, as inserting a result shifts the positions
  // of the messages after it
  for (let pass = 0; pass < 100; pass++) {
    const [pendingCall] = pendingToolCalls(chat);
    if (!pendingCall) break;
    const { tool_call_id, tool_name, index } = pendingCall;
    getState().log(
      2,
      `Missing tool result for ${tool_name || "unknown tool"} (${tool_call_id}), inserting placeholder`,
    );
    // the result must directly follow the message with the call, after any
    // results already given for the other calls in that same message
    let insertAt = index + 1;
    while (insertAt < chat.length && isToolResultMessage(chat[insertAt]))
      insertAt += 1;

    const buffer = [];
    await getState().functions.llm_add_message.run("tool_response", message, {
      chat: buffer,
      tool_call: { tool_call_id, tool_name: tool_name || "unknown_tool" },
    });
    if (!buffer.length) break; // cannot construct a result, do not spin
    chat.splice(insertAt, 0, ...buffer);
    repaired = true;
  }
  if (repaired) await addToContext(run, { interactions: chat });
  return repaired;
};

const process_interaction = async (
  run,
  config,
  req,
  agent_label = "Agent",
  prevResponses = [],
  triggering_row = {},
  agentsViewCfg = { stream: false },
  dyn_updates = false,
  is_sub_agent = false,
) => {
  const { stream, viewname, layout } = agentsViewCfg;
  const sysState = getState();
  const complArgs = await getCompletionArguments(
    config,
    req?.user,
    triggering_row,
    req?.body,
  );
  complArgs.appendToChat = true;
  complArgs.chat = run.context.interactions;
  const use_alt_config = complArgs.alt_config;
  //complArgs.debugResult = true;
  //console.log("complArgs", JSON.stringify(complArgs, null, 2));
  const debugMode = is_debug_mode(config, req?.user);
  const debugCollector = {};
  if (debugMode) complArgs.debugCollector = debugCollector;
  if (stream && viewname) {
    const view = View.findOne({ name: viewname });
    complArgs.streamCallback = (response) => {
      const content =
        typeof response === "string"
          ? response
          : response.choices[0].content || response.choices[0].delta?.content;
      if (content) {
        const pageLoadTag = req?.body?.page_load_tag;
        if (pageLoadTag)
          view.emitRealTimeEvent(`STREAM_CHUNK?page_load_tag=${pageLoadTag}`, {
            content,
          });
      }
    };
  }

  // never send a chat with unanswered tool calls to the LLM
  await ensureToolResults(run);

  const lastInteract =
    run.context.interactions[run.context.interactions.length - 1];

  const answer = await sysState.functions.llm_generate.run(
    lastInteract?.role === "user" || lastInteract?.role === "tool"
      ? ""
      : "Continue",
    complArgs,
  );

  //console.log("answer", answer);

  if (debugMode)
    await addToContext(run, {
      api_interactions: [debugCollector],
    });
  await addToContext(run, {
    interactions: complArgs.chat,
  });
  const responses = [];
  const raw_responses = [];

  const add_response = async (resp, not_final) => {
    if (dyn_updates)
      getState().emitDynamicUpdate(
        db.getTenantSchema(),
        {
          eval_js: `processCopilotResponse({response: ${JSON.stringify(resp)}, run_id: ${run.id}}, true)`,
          page_load_tag: req?.headers?.["page-load-tag"],
        },
        [req?.user?.id],
      );
    else responses.push(resp);
    await addToContext(run, {
      html_interactions: [resp],
    });
  };
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
          },
        );
        if (rendered)
          add_response(
            wrapSegment(
              wrapCard(
                tool.skill.skill_label || tool.skill.constructor.skill_name,
                rendered,
              ),
              agent_label,
              false,
              layout,
            ),
          );
      }
    }
    if (answer.content && !answer.tool_calls)
      add_response(
        req?.disable_markdown_render
          ? answer
          : wrapSegment(
              md.render(stripMarkdownImages(answer.content)),
              agent_label,
              false,
              layout,
            ),
      );
  }

  if (
    answer &&
    typeof answer === "object" &&
    (answer.hasToolCalls || answer.mcp_calls)
  ) {
    if (answer.content)
      add_response(
        req?.disable_markdown_render
          ? answer
          : wrapSegment(
              md.render(stripMarkdownImages(answer.content)),
              agent_label,
              false,
              layout,
            ),
      );
    //const actions = [];
    let hasResult = false;
    // a stop from any skill ends this agent turn, but it must never prevent a
    // tool call from getting a result
    let stopRequested = false;
    const stoppedCalls = new Set();
    if ((answer.mcp_calls || []).length && !answer.content) hasResult = true;
    const toolResults = {};
    if (answer.hasToolCalls)
      for (const tool_call of answer.getToolCalls()) {
        getState().log(6, "call function " + tool_call.tool_name);

        await addToContext(run, {
          funcalls: {
            [tool_call.tool_call_id]: tool_call,
          },
        });

        let tool;
        try {
          tool = find_tool(tool_call.tool_name, config);
        } catch (e) {
          getState().log(2, `Error finding tool ${tool_call.tool_name}: ${e}`);
        }

        if (tool) {
          let myHasResult = false;
          if (stream && viewname) {
            let content =
              (tool.skill.skill_label || tool.skill.constructor.skill_name) +
              "&nbsp;";
            const view = View.findOne({ name: viewname });
            const pageLoadTag = req?.body?.page_load_tag;
            if (pageLoadTag)
              view.emitRealTimeEvent(
                `STREAM_CHUNK?page_load_tag=${pageLoadTag}`,
                {
                  content,
                },
              );
          }
          const response_label = is_sub_agent
            ? agent_label
            : tool.skill.skill_label || tool.skill.constructor.skill_name;
          let rendered_tool_call = "";
          if (tool.tool.renderToolCall) {
            const row = tool_call.input;

            rendered_tool_call = await tool.tool.renderToolCall(row, {
              req,
            });
          }
          myHasResult = true;
          let result;
          try {
            result = await tool.tool.process(tool_call.input, {
              req,
              run,
            });
          } catch (e) {
            result = { error: e?.message || String(e) };
          }
          const tool_response = (result && result.add_response) || result;
          toolResults[tool_call.tool_call_id] = result;
          if (result?.stop) {
            stopRequested = true;
            stoppedCalls.add(tool_call.tool_call_id);
          }
          let add_user_action_html = "";
          if (result?.add_user_action) {
            const user_actions = Array.isArray()
              ? result.add_user_action
              : [result.add_user_action];
            for (const uact of user_actions) {
              uact.rndid = Math.floor(Math.random() * 16777215).toString(16);
              uact.tool_call = tool_call;
            }
            await addToContext(run, {
              user_actions,
            });
            add_user_action_html = div(
              { class: "d-flex mb-2" },
              user_actions.map((ua) =>
                button(
                  {
                    "data-useraction-id": ua.rndid,
                    class: "btn btn-primary", //press_store_button(this, true);
                    onclick: `view_post(${viewname ? `'${viewname}'` : `$(this).closest('[data-sc-embed-viewname]').attr('data-sc-embed-viewname')`}, 'execute_user_action', {uaname: "${ua.name}",rndid: "${ua.rndid}", run_id: ${run.id}}, processExecuteResponse)`,
                  },
                  ua.label,
                ),
              ),
            );
          }
          let rendered_tool_response = "";
          if (
            (typeof tool_response === "object" &&
              Object.keys(tool_response || {}).length) ||
            typeof tool_response === "string"
          ) {
            if (tool.tool.renderToolResponse) {
              rendered_tool_response = await tool.tool.renderToolResponse(
                tool_response,
                {
                  req,
                  tool_call,
                },
              );
            }
            myHasResult = true;
          }
          if (
            rendered_tool_call ||
            add_user_action_html ||
            rendered_tool_response
          )
            add_response(
              wrapSegment(
                div(
                  rendered_tool_call &&
                    wrapCard(
                      response_label,
                      typeof rendered_tool_call === "string"
                        ? md.render(rendered_tool_call)
                        : rendered_tool_call,
                    ),
                  rendered_tool_response,
                  add_user_action_html,
                ),
                agent_label,
                false,
                layout,
              ),
            );

          await sysState.functions.llm_add_message.run(
            "tool_response",
            !tool_response || typeof tool_response === "string"
              ? {
                  type: "text",
                  value: tool_response || "Action run",
                }
              : {
                  type: "json",
                  value: JSON.parse(JSON.stringify(tool_response)),
                },
            {
              chat: run.context.interactions,
              tool_call,
            },
          );

          await addToContext(run, {
            interactions: run.context.interactions,
          });

          if (myHasResult && !tool.tool.postProcess) hasResult = true;
        } else {
          // the tool is not available. The call must still be answered,
          // otherwise all subsequent LLM interactions fail
          await sysState.functions.llm_add_message.run(
            "tool_response",
            `Error: the tool ${tool_call.tool_name} is not available`,
            {
              chat: run.context.interactions,
              tool_call,
            },
          );
          await addToContext(run, {
            interactions: run.context.interactions,
          });
          hasResult = true;
        }
      }

    // all tool calls now have a response. Insert placeholders for any that
    // were missed, for instance because the answer had tool calls that were
    // not reported by getToolCalls()
    await ensureToolResults(run);

    const follow_up_prompts = [];
    let anyPostProcessRan = false;

    // postprocess - now all tool calls have responses
    if (answer.hasToolCalls)
      for (const tool_call of answer.getToolCalls()) {
        let tool;
        try {
          tool = find_tool(tool_call.tool_name, config);
        } catch (e) {
          getState().log(2, `Error finding tool ${tool_call.tool_name}: ${e}`);
        }
        if (tool) {
          // a skill that requested a stop when processing the call does not
          // also get to postprocess it
          if (
            tool.tool.postProcess &&
            !stoppedCalls.has(tool_call.tool_call_id)
          ) {
            let result = toolResults[tool_call.tool_call_id];
            const response_label = is_sub_agent
              ? agent_label
              : tool.skill.skill_label || tool.skill.constructor.skill_name;
            const chat = run.context.interactions;
            let generateUsed = false;
            const systemPrompt = await getSystemPrompt(
              config,
              req?.user,
              triggering_row,
              req?.body,
            );
            let postprocres;
            try {
              postprocres = await tool.tool.postProcess({
                tool_call,
                result,
                chat,
                req,
                run,
                agent_view_config: agentsViewCfg,
                dyn_updates,
                async generate(prompt, opts = {}) {
                  generateUsed = true;
                  return await sysState.functions.llm_generate.run(prompt, {
                    chat,
                    appendToChat: true,
                    systemPrompt,
                    ephemeralCacheControl: true,
                    alt_config: use_alt_config,
                    ...opts,
                  });
                },
                emit_update(s) {
                  if (!stream || !viewname) return;
                  const view = View.findOne({ name: viewname });
                  const pageLoadTag = req?.body?.page_load_tag;
                  if (pageLoadTag)
                    view.emitRealTimeEvent(
                      `STREAM_CHUNK?page_load_tag=${pageLoadTag}`,
                      {
                        content: s + "&nbsp;",
                      },
                    );
                },
              });
            } catch (e) {
              postprocres = { error: e?.message || String(e) };
            }
            if (!postprocres || typeof postprocres !== "object")
              postprocres = {};
            if (generateUsed) {
              // a generate() in postProcess can leave the chat with unanswered
              // tool calls
              await ensureToolResults(run);
              await addToContext(run, {
                interactions: run.context.interactions,
              });
            }
            if (postprocres.stop) stopRequested = true;
            if (postprocres.add_system_prompt)
              await addToContext(run, {
                interactions: [
                  ...chat,
                  { role: "system", content: postprocres.add_system_prompt },
                ],
              });
            if (postprocres.add_response) {
              if (!postprocres.add_responses)
                postprocres.add_responses = [postprocres.add_response];
              else postprocres.add_responses.push(postprocres.add_response);
            }

            for (const add_resp of postprocres.add_responses || []) {
              const content =
                add_resp.role && add_resp.content ? add_resp.content : add_resp;
              raw_responses.push(content);
              if (add_resp.md_response !== null) {
                const renderedAddResponse = add_resp.md_response
                  ? md.render(add_resp.md_response)
                  : typeof content === "string"
                    ? md.render(content)
                    : content;
                add_response(
                  wrapSegment(
                    wrapCard(response_label, renderedAddResponse),
                    agent_label,
                    false,
                    layout,
                  ),
                );
              }
              if (typeof add_resp.md_response !== "undefined")
                delete add_resp.md_response;

              const result = content;

              if (add_resp.role && add_resp.content) {
                await sysState.functions.llm_add_message.run(
                  add_resp.role,
                  add_resp.content,
                  {
                    chat: run.context.interactions,
                  },
                );
              } else
                await sysState.functions.llm_add_message.run(
                  "assistant",

                  !result || typeof result === "string"
                    ? result || "Action run"
                    : JSON.stringify(result),

                  {
                    chat: run.context.interactions,
                  },
                );

              await addToContext(run, {
                interactions: run.context.interactions,
              });
            }
            if (!postprocres.stop) {
              // the follow-up prompt is added after all tool calls have been
              // postprocessed, and only if no skill asked us to stop
              if (postprocres.follow_up_prompt)
                follow_up_prompts.push(postprocres.follow_up_prompt);
              anyPostProcessRan = true;
              hasResult = true;
            }
            if (postprocres.add_user_action && viewname) {
              const user_actions = Array.isArray()
                ? postprocres.add_user_action
                : [postprocres.add_user_action];
              for (const uact of user_actions) {
                uact.rndid = Math.floor(Math.random() * 16777215).toString(16);
                uact.tool_call = tool_call;
              }
              await addToContext(run, {
                user_actions,
              });
              add_response(
                div(
                  { class: "d-flex mb-2" },
                  user_actions.map((ua) =>
                    button(
                      {
                        class: "btn btn-primary", //press_store_button(this, true);
                        onclick: `view_post('${viewname}', 'execute_user_action', {uaname: "${ua.name}",rndid: "${ua.rndid}", run_id: ${run.id}}, processExecuteResponse)`,
                      },
                      ua.label,
                    ),
                  ),
                ),
              );
            }
          }
        }
      }

    if (anyPostProcessRan && !stopRequested) {
      const lastInteract =
        run.context.interactions[run.context.interactions.length - 1];
      if (
        follow_up_prompts.length ||
        !(lastInteract?.role === "user" || lastInteract?.role === "tool")
      ) {
        await sysState.functions.llm_add_message.run(
          "user",
          follow_up_prompts.length
            ? nubBy((s) => s, follow_up_prompts).join("\n\n")
            : "Continue with the query",
          {
            chat: run.context.interactions,
          },
        );
        await addToContext(run, {
          interactions: run.context.interactions,
        });
      }
    }

    // the chat is left in a state where the next interaction, which may be
    // started by the user rather than here, can always be sent to the LLM
    await ensureToolResults(run);

    //await db.commitAndBeginNewTransaction();
    const freshRun = await WorkflowRun.findOne({ id: run.id });

    if (hasResult && !stopRequested && freshRun.status !== "Cancel")
      return await process_interaction(
        run,
        config,
        req,
        agent_label,
        [...prevResponses, ...responses],
        triggering_row,
        agentsViewCfg,
        dyn_updates,
        is_sub_agent,
      );
  } else if (typeof answer === "string")
    add_response(
      req?.disable_markdown_render
        ? answer
        : wrapSegment(
            md.render(stripMarkdownImages(answer)),
            agent_label,
            false,
            layout,
          ),
    );
  if (dyn_updates && !is_sub_agent)
    getState().emitDynamicUpdate(
      db.getTenantSchema(),
      {
        eval_js: `final_agent_response()`,
        page_load_tag: req?.headers?.["page-load-tag"],
      },
      [req?.user?.id],
    );

  return {
    json: {
      success: "ok",
      ...(is_sub_agent && !stream ? { raw_responses } : {}),
      response: [...prevResponses, ...responses].join(""),
      run_id: run?.id,
    },
  };
};

const replaceUserContinue = (chat, newPrompt) => {
  const lastChat = chat[chat.length - 1];
  console.log("lastChat", lastChat);
};

module.exports = {
  get_skills,
  get_skill_class,
  replaceUserContinue,
  incompleteCfgMsg,
  find_tool,
  get_skill_instances,
  getCompletionArguments,
  addToContext,
  saveInteractions,
  wrapCard,
  wrapSegment,
  process_interaction,
  pendingToolCalls,
  ensureToolResults,
  find_image_tool,
  is_debug_mode,
  get_initial_interactions,
  nubBy,
  extractText,
  stripMarkdownImages,
};
