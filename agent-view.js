const Field = require("@saltcorn/data/models/field");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const View = require("@saltcorn/data/models/view");
const File = require("@saltcorn/data/models/file");
const Trigger = require("@saltcorn/data/models/trigger");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const db = require("@saltcorn/data/db");
const WorkflowRun = require("@saltcorn/data/models/workflow_run");
const Workflow = require("@saltcorn/data/models/workflow");
const { localeDateTime } = require("@saltcorn/markup");
const {
  div,
  script,
  domReady,
  pre,
  code,
  input,
  h4,
  h3,
  style,
  h5,
  button,
  text_attr,
  i,
  p,
  span,
  small,
  form,
  textarea,
  label,
  a,
  br,
  img,
  text,
} = require("@saltcorn/markup/tags");
const { getState } = require("@saltcorn/data/db/state");
const {
  incompleteCfgMsg,
  getCompletionArguments,
  find_tool,
  addToContext,
  wrapCard,
  wrapSegment,
  process_interaction,
  find_image_tool,
  is_debug_mode,
  get_initial_interactions,
  get_skill_instances,
  saveInteractions,
} = require("./common");
const MarkdownIt = require("markdown-it"),
  md = new MarkdownIt({ html: true, breaks: true, linkify: true });
const { isWeb, escapeHtml } = require("@saltcorn/data/utils");
const path = require("path");

const configuration_workflow = (req) =>
  new Workflow({
    steps: [
      {
        name: "Agent action",
        form: async (context) => {
          const agent_actions = await Trigger.find({ action: "Agent" });
          return new Form({
            fields: [
              {
                name: "action_id",
                label: "Agent action",
                type: "String",
                required: true,
                attributes: {
                  options: agent_actions.map((a) => ({
                    label: a.name,
                    name: a.id,
                  })),
                },
                sublabel:
                  "A trigger with <code>Agent</code> action. " +
                  a(
                    {
                      "data-dyn-href": `\`/actions/configure/\${action_id}\``,
                      target: "_blank",
                    },
                    "Configure",
                  ),
              },
              {
                name: "show_prev_runs",
                label: "Show previous runs",
                type: "Bool",
              },
              {
                name: "prev_runs_closed",
                label: "Initially closed",
                type: "Bool",
                showIf: { show_prev_runs: true },
              },
              {
                name: "stream",
                label: "Stream response",
                type: "Bool",
              },
              {
                name: "placeholder",
                label: "Placeholder",
                type: "String",
                default: "How can I help you?",
              },
              {
                name: "explainer",
                label: "Explainer",
                type: "String",
                sublabel:
                  "Appears below the input box. Use for additional instructions.",
              },
              {
                name: "layout",
                label: "Layout",
                type: "String",
                required: true,
                attributes: {
                  options: ["Standard", "No card", "Modern chat", "Modern chat - no card"],
                },
              },
              {
                name: "image_upload",
                label: "Upload images",
                sublabel: "Allow the user to upload images",
                type: "Bool",
              },
              /*{
                name: "audio_recorder",
                label: "Audio recorder",
                sublabel: "Allow the user to record audio for input",
                type: "Bool",
              },*/
              {
                name: "image_base64",
                label: "base64 encode",
                sublabel: "Use base64 encoding in the OpenAI API",
                type: "Bool",
                showIf: { image_upload: true },
              },
            ],
          });
        },
      },
    ],
  });

const get_state_fields = async (table_id) =>
  table_id
    ? [
        {
          name: "id",
          type: "Integer",
          primary_key: true,
        },
      ]
    : [];

const uploadForm = (viewname, req) =>
  span(
    {
      class: "attach_agent_image_wrap",
    },
    label(
      { class: "btn-link", for: "attach_agent_image" },
      i({ class: "fas fa-paperclip" }),
    ),
    input({
      id: "attach_agent_image",
      name: "file",
      type: "file",
      class: "d-none",
      accept: "image/*",
      multiple: true,
      onchange: `agent_file_attach(event)`,
    }),
    span({ class: "ms-2 filename-label" }),
  );

const realTimeCollabScript = (viewname, rndid, layout) => {
  const view = View.findOne({ name: viewname });
  return script(
    domReady(`
      const md = markdownit({html: true, breaks: true, linkify: true})
      window['stream scratch ${viewname} ${rndid}'] = []
  const callback = () => {
    const collabCfg = {
      events: {
        ['${view.getRealTimeEventName(
          "STREAM_CHUNK",
        )}' + \`?page_load_tag=\${_sc_pageloadtag}\`]: async (data) => {
          window['stream scratch ${viewname} ${rndid}'].push(data.content)
          const rendered = md.render(window['stream scratch ${viewname} ${rndid}'].join(""));
          $('form.agent-view div.next_response_scratch').html(
            (${JSON.stringify(layout || "")} || "").startsWith("Modern chat")
              ? '<div class="chat-message chat-assistant"><div class="chat-avatar"><i class="fas fa-robot"></i></div><div class="chat-bubble">' + rendered + '</div></div>'
              : rendered
          );
        }
      }
    };
    let retries = 0
    function init_it() {
      if(window.io) init_collab_room('${viewname}', collabCfg);
      else setTimeout(init_it, retries * 100);
      retries+=1;
    }
    init_it();
  };

  if (ensure_script_loaded.length >= 2) {
    ensure_script_loaded("/static_assets/${
      db.connectObj.version_tag
    }/socket.io.min.js", callback);
  }
  else {
    //legacy
    ensure_script_loaded("/static_assets/${
      db.connectObj.version_tag
    }/socket.io.min.js");
    callback();
  }`),
  );
};

const run = async (
  table_id,
  viewname,
  {
    action_id,
    agent_action,
    show_prev_runs,
    prev_runs_closed,
    placeholder,
    explainer,
    image_upload,
    stream,
    audio_recorder,
    layout,
  },
  state,
  { res, req },
) => {
  const action = agent_action || (await Trigger.findOne({ id: action_id }));
  if (!action) throw new Error(`Action not found: ${action_id}`);
  const prevRuns = show_prev_runs
    ? (
        await WorkflowRun.find(
          { trigger_id: action.id, started_by: req.user?.id },
          { orderBy: "started_at", orderDesc: true, limit: 30 },
        )
      ).filter((r) => r.context.interactions)
    : null;

  const cfgMsg = incompleteCfgMsg();
  if (cfgMsg) return cfgMsg;
  let runInteractions = "";
  let triggering_row_id;
  if (table_id) {
    const table = Table.findOne(table_id);
    const pk = table?.pk_name;
    if (table && state[pk])
      //triggering_row = await table.getRow({ [pk]: state[pk] });
      triggering_row_id = state[pk];
  }
  const initial_q = state.run_id ? undefined : state._q;
  if (state.run_id) {
    const run = prevRuns
      ? prevRuns.find((r) => r.id == state.run_id)
      : await WorkflowRun.findOne({
          trigger_id: action.id,
          started_by: req.user?.id,
          id: state.run_id,
        });
    const interactMarkups = [];
    if (run.context.html_interactions) {
      interactMarkups.push(...run.context.html_interactions);
    } else
      for (const interact of run.context.interactions) {
        //legacy
        switch (interact.role) {
          case "user":
            if (interact.content?.[0]?.type === "image_url") {
              const image_url = interact.content[0].image_url.url;
              if (image_url.startsWith("data"))
                interactMarkups.push(
                  wrapSegment("File", "You", true, layout),
                );
              else
                interactMarkups.push(
                  wrapSegment(
                    a({ href: image_url, target: "_blank" }, "File"),
                    "You",
                    true,
                    layout,
                  ),
                );
            } else
              interactMarkups.push(
                wrapSegment(
                  md.render(interact.content),
                  "You",
                  true,
                  layout,
                ),
              );
            break;
          case "assistant":
          case "system":
            for (const tool_call of interact.tool_calls || []) {
              const toolSkill = find_tool(
                tool_call.function?.name,
                action.configuration,
              );
              if (toolSkill) {
                const row = JSON.parse(tool_call.function.arguments);
                if (toolSkill.tool.renderToolCall) {
                  const rendered = await toolSkill.tool.renderToolCall(row, {
                    req,
                  });
                  if (rendered)
                    interactMarkups.push(
                      wrapSegment(
                        wrapCard(
                          toolSkill.skill.skill_label ||
                            toolSkill.skill.constructor.skill_name,
                          rendered,
                        ),
                        action.name,
                        false,
                        layout,
                      ),
                    );
                }
              }
            }
            for (const image_call of interact.content?.image_calls || []) {
              const toolSkill = find_image_tool(action.configuration);
              if (toolSkill) {
                if (toolSkill.tool.renderToolResponse) {
                  const rendered = await toolSkill.tool.renderToolResponse(
                    image_call,
                    {
                      req,
                    },
                  );

                  if (rendered)
                    interactMarkups.push(
                      wrapSegment(
                        wrapCard(
                          toolSkill.skill.skill_label ||
                            toolSkill.skill.constructor.skill_name,
                          rendered,
                        ),
                        action.name,
                        false,
                        layout,
                      ),
                    );
                }
              }
            }
            if (
              typeof interact.content === "string" ||
              typeof interact.content?.content === "string"
            )
              interactMarkups.push(
                wrapSegment(
                  typeof interact.content === "string"
                    ? md.render(interact.content)
                    : typeof interact.content?.content === "string"
                      ? md.render(interact.content.content)
                      : interact.content,
                  action.name,
                  false,
                  layout,
                ),
              );
            break;
          case "tool":
            if (interact.content !== "Action run") {
              let markupContent;
              const toolSkill = find_tool(interact.name, action.configuration);
              try {
                if (toolSkill?.tool?.renderToolResponse)
                  markupContent = await toolSkill?.tool?.renderToolResponse?.(
                    JSON.parse(interact.content),
                    {
                      req,
                    },
                  );
              } catch {
                markupContent = pre(interact.content);
              }
              if (markupContent)
                interactMarkups.push(
                  wrapSegment(
                    wrapCard(
                      toolSkill?.skill?.skill_label ||
                        toolSkill?.skill?.constructor.skill_name ||
                        interact.name,
                      markupContent,
                    ),
                    action.name,
                    false,
                    layout,
                  ),
                );
            }
            break;
        }
      }
    runInteractions = interactMarkups.join("");
  }
  const skill_form_widgets = [];
  for (const skill of get_skill_instances(action.configuration)) {
    if (skill.formWidget)
      skill_form_widgets.push(
        await skill.formWidget({
          user: req.user,
          viewname,
          klass: "skill-form-widget",
        }),
      );
  }

  const debugMode = is_debug_mode(action.configuration, req.user);
  const dyn_updates = getState().getConfig("enable_dynamic_updates", true);

  const rndid = Math.floor(Math.random() * 16777215).toString(16);
  const input_form = form(
    {
      onsubmit: `event.preventDefault();spin_send_button();view_post('${viewname}', 'interact', new FormData(this), ${dyn_updates ? "null" : "processCopilotResponse"});return false;`,
      class: ["form-namespace copilot mt-2 agent-view"],
      method: "post",
    },
    input({
      type: "hidden",
      name: "_csrf",
      value: req.csrfToken(),
    }),
    input({
      type: "hidden",
      name: "run_id",
      value: state.run_id ? +state.run_id : undefined,
    }),
    input({
      type: "hidden",
      name: "page_load_tag",
      value: "",
    }),
    input({
      type: "hidden",
      class: "form-control  ",
      name: "triggering_row_id",
      value: triggering_row_id || "",
    }),
    div(
      { class: "copilot-entry" },
      textarea(
        {
          class: "form-control",
          name: "userinput",
          "data-fieldname": "userinput",
          placeholder: placeholder || "How can I help you?",
          id: "inputuserinput",
          rows: "3",
          autofocus: true,
        },
        initial_q,
      ),
      span(
        { class: "submit-button p-2", onclick: "$('form.copilot').submit()" },
        i({ id: "sendbuttonicon", class: "far fa-paper-plane" }),
      ),
      image_upload && uploadForm(viewname, req),
      debugMode &&
        i({
          onclick: "press_agent_debug_button()",
          class: "debugicon fas fa-bug",
        }),
      skill_form_widgets,
      audio_recorder &&
        span(
          { id: "audioinputicon", class: "", onclick: "" },
          i({ class: "fas fa-microphone" }),
        ),
      explainer && small({ class: "explainer" }, i(explainer)),
    ),
    stream &&
      realTimeCollabScript(viewname, rndid, layout) +
        div({ class: "next_response_scratch" }),
  );

  const isModernSidebar = layout && layout.startsWith("Modern chat");
  const prev_runs_side_bar = show_prev_runs
    ? div(
        { class: isModernSidebar ? "modern-sessions" : "" },
        isModernSidebar
          ? div(
              { class: "modern-sessions-header" },
              div(
                { class: "d-flex align-items-center" },
                i({
                  class: "fas fa-caret-down me-2 session-open-sessions",
                  onclick: "close_session_list()",
                }),
                i({ class: "fas fa-comments me-2 text-primary" }),
                span({ class: "fw-semibold" }, req.__("Sessions")),
              ),
              button(
                {
                  type: "button",
                  class: "btn btn-primary btn-sm rounded-pill px-3",
                  onclick: "unset_state_field('run_id')",
                  title: "New chat",
                },
                i({ class: "fas fa-plus me-1" }),
                "New",
              ),
            )
          : div(
              {
                class: "d-flex flex-wrap justify-content-between align-middle mb-2",
              },
              div(
                { class: "d-flex" },
                i({
                  class: "fas fa-caret-down me-1 session-open-sessions",
                  onclick: "close_session_list()",
                }),
                h5(req.__("Sessions")),
              ),
              button(
                {
                  type: "button",
                  class: "btn btn-secondary btn-sm pt-0 pb-1",
                  style: "font-size: 0.9em;height:1.5em",
                  onclick: "unset_state_field('run_id')",
                  title: "New session",
                },
                i({ class: "fas fa-redo fa-sm" }),
              ),
            ),
        prevRuns.map((run) => {
          const isActive = state.run_id && +state.run_id === run.id;
          const preview = escapeHtml(
            run.context.interactions
              .find((ix) => typeof ix?.content === "string")
              ?.content?.substring?.(0, 80),
          );
          return isModernSidebar
            ? div(
                {
                  onclick: `set_state_field('run_id',${run.id})`,
                  class:
                    "prevcopilotrun modern-session-item" +
                    (isActive ? " active-session" : ""),
                },
                div(
                  { class: "d-flex justify-content-between align-items-center mb-1" },
                  small(
                    { class: "text-muted text-truncate", style: "min-width:0" },
                    localeDateTime(run.started_at),
                  ),
                  i({
                    class: "far fa-trash-alt text-muted",
                    onclick: `delprevrun(event, ${run.id})`,
                  }),
                ),
                p({ class: "prevrun_content mb-0" }, preview),
              )
            : div(
                {
                  onclick: `set_state_field('run_id',${run.id})`,
                  class: "prevcopilotrun border p-2",
                },
                div(
                  { class: "d-flex justify-content-between" },
                  span(
                    { class: "text-truncate", style: "min-width:0" },
                    localeDateTime(run.started_at),
                  ),
                  i({
                    class: "far fa-trash-alt",
                    onclick: `delprevrun(event, ${run.id})`,
                  }),
                ),
                p(
                  { class: "prevrun_content" },
                  preview,
                ),
              );
        }),
      )
    : "";

  const main_inner = div(
    div(
      {
        class: "open-prev-runs",
        style: prev_runs_closed ? {} : { display: "none" },
        onclick: "open_session_list()",
      },
      i({
        class: "fas fa-caret-right me-1",
      }),
      req.__("Sessions"),
    ),
    div({ id: "copilotinteractions" }, runInteractions),
    input_form,
    style(
      `div.interaction-segment:not(:first-child) {border-top: 1px solid #e7e7e7; }
              div.interaction-segment {padding-top: 5px;padding-bottom: 5px;}
              div.interaction-segment p {margin-bottom: 0px;}
              div.interaction-segment div.card {margin-top: 0.5rem;}
              div.interaction-segment.to-right {
              display: flex;             
    flex-direction: row-reverse;
}
    div.interaction-segment.to-right div.badgewrap {
              display: flex;             
    flex-direction: row-reverse;
}
            div.prevcopilotrun:hover {cursor: pointer; background-color: var(--tblr-secondary-bg-subtle, var(--bs-secondary-bg-subtle, gray));}
            div.prevcopilotrun i.fa-trash-alt {display: none;}
            div.prevcopilotrun:hover i.fa-trash-alt {display: block;}
            .copilot-entry .submit-button:hover { cursor: pointer}
            .copilot-entry span.attach_agent_image_wrap i:hover { cursor: pointer}

            .copilot-entry .submit-button {
              position: relative; 
              top: -1.8rem;
              left: 0.1rem;              
            }
            .copilot-entry #audioinputicon {
              position: relative; 
              top: -1.8rem;
              right: 0.7rem;
              cursor: pointer;
              float: right;
            }
            .copilot-entry .debugicon {
              position: relative; 
              top: -1.8rem;
              left: 0.1rem;
              cursor: pointer;
            }
            .copilot-entry .skill-form-widget {
              position: relative; 
              top: -2rem;
              left: 0.4rem;
              display: inline;
            }
              .session-open-sessions, .open-prev-runs {
              cursor: pointer;
              }
              .copilot-entry span.attach_agent_image_wrap {
              position: relative;
              top: -1.8rem;
              left: 0.2rem;
            }
              .copilot-entry.dragover {
              outline: 2px dashed var(--tblr-primary, #0054a6);
              outline-offset: -2px;
              background: var(--tblr-primary-bg-subtle, rgba(0, 84, 166, 0.05));
              border-radius: 0.25rem;
            }
              .copilot-entry .explainer {
              position: relative; 
              top: -1.2rem;    
              display: block;                        
            }
              .col-0 {
              width: 0%
              }
            .copilot-entry {margin-bottom: -1.25rem; margin-top: 1rem;}
            p.prevrun_content {
               white-space: nowrap;
    overflow: hidden;
    margin-bottom: 0px;
    display: block;
    text-overflow: ellipsis;}
            /* Modern Chat Layout */
            .modern-chat-layout {
              display: flex;
              flex-direction: column;
              height: 100%;
            }
            .modern-chat-layout #copilotinteractions {
              max-height: 70vh;
              overflow-y: auto;
              padding: 1rem;
              display: flex;
              flex-direction: column;
              gap: 0.75rem;
            }
            .modern-chat-layout .chat-message {
              display: flex;
              gap: 0.5rem;
              max-width: 85%;
              align-items: flex-start;
            }
            .modern-chat-layout .chat-message.chat-user {
              align-self: flex-end;
              flex-direction: row-reverse;
            }
            .modern-chat-layout .chat-message.chat-assistant {
              align-self: flex-start;
            }
            .modern-chat-layout .chat-avatar {
              width: 2rem;
              height: 2rem;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              flex-shrink: 0;
              font-size: 0.85rem;
              background: var(--tblr-secondary-bg-subtle, var(--bs-secondary-bg-subtle, #e9ecef));
              color: var(--tblr-secondary-color, var(--bs-secondary-color, #6c757d));
            }
            .modern-chat-layout .chat-user .chat-avatar {
              background: #0d6efd;
              color: #fff;
            }
            .modern-chat-layout .chat-bubble {
              padding: 0.6rem 1rem;
              border-radius: 1rem;
              line-height: 1.5;
              word-wrap: break-word;
              overflow-wrap: break-word;
            }
            .modern-chat-layout .chat-user .chat-bubble {
              background: #0d6efd;
              color: #fff;
              border-bottom-right-radius: 0.25rem;
            }
            .modern-chat-layout .chat-assistant .chat-bubble {
              background: var(--tblr-secondary-bg-subtle, var(--bs-secondary-bg-subtle, #f0f2f5));
              color: var(--tblr-body-color, var(--bs-body-color, #212529));
              border-bottom-left-radius: 0.25rem;
            }
            /* Markdown content inside bubbles */
            .modern-chat-layout .chat-bubble h1,
            .modern-chat-layout .chat-bubble h2,
            .modern-chat-layout .chat-bubble h3,
            .modern-chat-layout .chat-bubble h4 {
              margin-top: 0.5rem;
              margin-bottom: 0.25rem;
            }
            .modern-chat-layout .chat-bubble h1 { font-size: 1.3rem; }
            .modern-chat-layout .chat-bubble h2 { font-size: 1.15rem; }
            .modern-chat-layout .chat-bubble h3 { font-size: 1.05rem; }
            .modern-chat-layout .chat-bubble h4 { font-size: 1rem; }
            .modern-chat-layout .chat-bubble p {
              margin-bottom: 0.4rem;
            }
            .modern-chat-layout .chat-bubble p:last-child {
              margin-bottom: 0;
            }
            .modern-chat-layout .chat-bubble ul,
            .modern-chat-layout .chat-bubble ol {
              padding-left: 1.5rem;
              margin-bottom: 0.4rem;
            }
            .modern-chat-layout .chat-bubble table {
              width: 100%;
              border-collapse: collapse;
              margin: 0.5rem 0;
              font-size: 0.9em;
            }
            .modern-chat-layout .chat-bubble table th,
            .modern-chat-layout .chat-bubble table td {
              border: 1px solid rgba(0,0,0,0.15);
              padding: 0.3rem 0.5rem;
            }
            .modern-chat-layout .chat-bubble table th {
              background: rgba(0,0,0,0.05);
              font-weight: 600;
            }
            .modern-chat-layout .chat-bubble pre {
              background: rgba(0,0,0,0.06);
              padding: 0.5rem;
              border-radius: 0.5rem;
              overflow-x: auto;
              margin: 0.4rem 0;
            }
            .modern-chat-layout .chat-bubble code {
              font-size: 0.88em;
            }
            .modern-chat-layout .chat-bubble p > code {
              background: rgba(0,0,0,0.06);
              padding: 0.1rem 0.3rem;
              border-radius: 0.25rem;
            }
            .modern-chat-layout .chat-user .chat-bubble pre {
              background: rgba(255,255,255,0.15);
            }
            .modern-chat-layout .chat-user .chat-bubble p > code {
              background: rgba(255,255,255,0.15);
            }
            .modern-chat-layout .chat-user .chat-bubble table th,
            .modern-chat-layout .chat-user .chat-bubble table td {
              border-color: rgba(255,255,255,0.25);
            }
            .modern-chat-layout .chat-user .chat-bubble table th {
              background: rgba(255,255,255,0.1);
            }
            /* Input area for modern chat */
            .modern-chat-layout .copilot-entry {
              border-top: 1px solid var(--tblr-border-color, var(--bs-border-color, #dee2e6));
              padding-top: 0.75rem;
              margin-top: 0.5rem;
            }
            .modern-chat-layout .copilot-entry textarea {
              border-radius: 1.5rem;
              padding: 0.6rem 1rem;
              resize: none;
            }
            /* Streaming scratch in modern chat */
            .modern-chat-layout .next_response_scratch {
              padding: 0 1rem;
            }
            .modern-chat-layout .next_response_scratch:not(:empty) {
              margin-bottom: 0.5rem;
            }
            /* Interaction segment (tool cards) inside modern chat */
            .modern-chat-layout .interaction-segment {
              border-top: none;
            }
            /* Modern Sessions Sidebar */
            .modern-sessions-header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              padding: 0.6rem 0.75rem;
              margin-bottom: 0.75rem;
              background: var(--tblr-secondary-bg-subtle, var(--bs-secondary-bg-subtle, #f8f9fa));
              border-radius: 0.75rem;
              border-bottom: 1px solid var(--tblr-border-color, var(--bs-border-color, #dee2e6));
              position: sticky;
              top: 0;
              z-index: 1;
            }
            .modern-sessions .modern-session-item {
              border-radius: 0.75rem;
              padding: 0.65rem 0.75rem;
              margin-bottom: 0.4rem;
              border: 1px solid var(--tblr-border-color, var(--bs-border-color, #dee2e6));
              cursor: pointer;
              transition: all 0.15s ease;
            }
            .modern-sessions .modern-session-item:hover {
              box-shadow: 0 2px 8px rgba(0,0,0,0.07);
              background-color: var(--tblr-secondary-bg-subtle, var(--bs-secondary-bg-subtle, #f8f9fa));
            }
            .modern-sessions .modern-session-item.active-session {
              border-left: 3px solid #0d6efd;
              background-color: rgba(13, 110, 253, 0.05);
            }
            .modern-sessions .modern-session-item i.fa-trash-alt {
              display: none;
              font-size: 0.8em;
            }
            .modern-sessions .modern-session-item:hover i.fa-trash-alt {
              display: inline;
            }
            .modern-sessions .modern-session-item .prevrun_content {
              font-size: 0.85em;
              color: var(--tblr-secondary-color, var(--bs-secondary-color, #6c757d));
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }`,
    ),
    script(domReady(`$( "#inputuserinput" ).autogrow({paddingBottom: 20});`)),
    script(
      `
    function close_session_list() {
      $("div.prev-runs-list").hide().parents(".col-3").removeClass("col-3").addClass("was-col-3").parent().children(".col-9").removeClass("col-9").addClass("col-12")
      $("div.open-prev-runs").show()
    }
    function open_session_list() {
      $("div.prev-runs-list").show().parents(".was-col-3").removeClass(["was-col-3","col-0","d-none"]).addClass("col-3").parent().children(".col-12").removeClass("col-12").addClass("col-9")
      $("div.open-prev-runs").hide()
    }
    function get_run_id(elem) {
        return $("input[name=run_id").val()
    }
    function processCopilotResponse(res, not_final) {        
        console.log("processCopilotResponse", res)
        const fileInput = $("input#attach_agent_image")[0];
        let fileBadge = "";
        if (fileInput?.files?.length) {
          fileBadge = Array.from(fileInput.files).map(f =>
            '<span class="badge text-bg-info"><i class="fas fa-image me-1"></i>'+f.name+'</span>'
          ).join(" ");
        }
        $("span.filename-label").text("").removeClass("me-2");
        window._agentDT.items.clear();
        $("input#attach_agent_image").val(null);
        if(!not_final || (!${JSON.stringify(dyn_updates)})) $("#sendbuttonicon").attr("class","far fa-paper-plane");
        const $runidin= $("input[name=run_id")
        if(res.run_id && (!$runidin.val() || $runidin.val()=="undefined"))
          $runidin.val(res.run_id);
        const currentLayout = ${JSON.stringify(layout || "")};
        const wrapSegment = (html, who, toRight) => currentLayout.startsWith("Modern chat")
          ? '<div class="chat-message '+(toRight ? 'chat-user' : 'chat-assistant')+'"><div class="chat-avatar"><i class="fas '+(toRight ? 'fa-user' : 'fa-robot')+'"></i></div><div class="chat-bubble">'+html+'</div></div>'
          : '<div class="interaction-segment '+(toRight ? 'to-right' : '')+'"><div><div class="badgewrap"><span class="badge bg-secondary">'+who+'</span></div>'+html+'</div></div>'
        const user_input = $("textarea[name=userinput]").val()
        if(user_input && (!${JSON.stringify(dyn_updates)}))
          $("#copilotinteractions").append(wrapSegment('<p>'+user_input+'</p>'+fileBadge, "You", true))
        $("textarea[name=userinput]").val("")
        $('form.agent-view div.next_response_scratch').html("")
        window['stream scratch ${viewname} ${rndid}'] = []
        if(res.response)
            $("#copilotinteractions").append(res.response)
    }
    window.processCopilotResponse = processCopilotResponse;
    window.final_agent_response = () => {
      $("#sendbuttonicon").attr("class","far fa-paper-plane");
    }
    window._agentDT = new DataTransfer();
    function setAgentFiles(files) {
        for (const f of files) window._agentDT.items.add(f);
        document.getElementById('attach_agent_image').files = window._agentDT.files;
        updateFileLabel();
    }
    function updateFileLabel() {
        const n = window._agentDT.files.length;
        const $label = $(".attach_agent_image_wrap span.filename-label");
        if (n === 0) {
          $label.html("").removeClass("me-2");
        } else {
          $label.addClass("me-2");
          const text = n === 1 ? window._agentDT.files[0].name : n + " files";
          $label.html(${
            isWeb(req)
              ? `text + ' <span class="badge text-bg-secondary" style="cursor:pointer;font-size:.65em;vertical-align:middle" onclick="clearAgentFiles()" title="Remove files">&times;</span>'`
              : `'<span style="max-width:8em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle">' + text + '</span> <span class="badge text-bg-secondary" style="cursor:pointer;font-size:.65em;vertical-align:middle" onclick="clearAgentFiles()" title="Remove files">&times;</span>'`
          });
        }
    }
    function clearAgentFiles() {
        window._agentDT.items.clear();
        $("input#attach_agent_image").val(null);
        updateFileLabel();
    }
    window.clearAgentFiles = clearAgentFiles;
    function agent_file_attach(e) {
        window._agentDT.items.clear();
        setAgentFiles(e.target.files);
    }
    function restore_old_button_elem(btn) {
        const oldText = $(btn).data("old-text");
        btn.html(oldText);
        btn.css({ width: "" }).prop("disabled", false);
        btn.removeData("old-text");
    }
    function press_agent_debug_button() {
        const $runidin= $("input[name=run_id")
        const runid = $runidin.val()
        if(runid)
        view_post('${viewname}', 'debug_info', {run_id:runid, triggering_row_id:$("input[name=triggering_row_id").val()}, show_agent_debug_info)
    }
    function show_agent_debug_info(info) {
      ensure_modal_exists_and_closed();
      $("#scmodal .modal-body").html(info.debug_html);
      $("#scmodal .modal-title").html(decodeURIComponent("Agent session information"));
      $(".modal-dialog").css("min-width", "80%");
      new bootstrap.Modal($("#scmodal"), {
        focus: false,
      }).show();      
    }
    function delprevrun(e, runid) {
        e.preventDefault();
        e.stopPropagation();
        view_post('${viewname}', 'delprevrun', {run_id:runid})
        $(e.target).closest(".prevcopilotrun").remove()
        return false;
    }
    function processExecuteResponse(res) {
        const btn = $("#exec-"+res.fcall_id)
        restore_old_button_elem($("#exec-"+res.fcall_id))
        btn.prop('disabled', true);
        btn.html('<i class="fas fa-check me-1"></i>Applied')
        btn.removeClass("btn-primary")
        btn.addClass("btn-secondary")
        if(res.postExec) {
          $('#postexec-'+res.fcall_id).html(res.postExec)
        }
    }
    function submitOnEnter(event) {
        if (event.which === 13 && !event.shiftKey) {
            if (!event.repeat) {
                const newEvent = new Event("submit", {cancelable: true});
                event.target.form.dispatchEvent(newEvent);
            }

            event.preventDefault(); // Prevents the addition of a new line in the text field
        }        
    }
    document.getElementById("inputuserinput").addEventListener("keydown", submitOnEnter);
    if (document.getElementById('attach_agent_image')) {
      let _dragCtr = 0;
      const _copilotEntry = document.querySelector('.copilot-entry');
      _copilotEntry.addEventListener('dragover', function(e) {
        e.preventDefault();
      });
      _copilotEntry.addEventListener('dragenter', function(e) {
        e.preventDefault();
        _dragCtr++;
        this.classList.add('dragover');
      });
      _copilotEntry.addEventListener('dragleave', function(e) {
        _dragCtr--;
        if (_dragCtr === 0) this.classList.remove('dragover');
      });
      _copilotEntry.addEventListener('drop', function(e) {
        e.preventDefault();
        _dragCtr = 0;
        this.classList.remove('dragover');
        const imgs = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        if (imgs.length) setAgentFiles(imgs);
      });
      document.getElementById('inputuserinput').addEventListener('paste', function(e) {
        const items = e.clipboardData?.items;
        if (!items) return;
        const pastedFiles = [];
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) pastedFiles.push(file);
          }
        }
        if (pastedFiles.length) {
          e.preventDefault();
          setAgentFiles(pastedFiles);
        }
      });
    }
    function spin_send_button() {
      $("#sendbuttonicon").attr("class","fas fa-spinner fa-spin");
    };`,
      stream &&
        domReady(
          `$('form.agent-view input[name=page_load_tag]').val(window._sc_pageloadtag)`,
        ),
      initial_q && domReady("$('form.copilot').submit()"),
    ),
  );
  const isModern = layout && layout.startsWith("Modern chat");
  const main_chat =
    layout === "Modern chat"
      ? div({ class: "card" }, div({ class: "card-body modern-chat-layout" }, main_inner))
      : layout === "Modern chat - no card"
        ? div({ class: "modern-chat-layout" }, main_inner)
        : layout === "No card"
          ? div({ class: "mx-1" }, main_inner)
          : div({ class: "card" }, div({ class: "card-body" }, main_inner));

  return show_prev_runs
    ? div(
        { class: "row gx-3" },
        div(
          { class: prev_runs_closed ? "was-col-3 d-none" : "col-3" },
          div({ class: "prev-runs-list" }, prev_runs_side_bar),
        ),
        div({ class: prev_runs_closed ? "col-12" : "col-9" }, div(main_chat)),
      )
    : main_chat;
};

const interact = async (table_id, viewname, config, body, { req, res }) => {
  const { userinput, run_id, triggering_row_id } = body;
  const action =
    config.agent_action || (await Trigger.findOne({ id: config.action_id }));

  let run;
  let triggering_row;
  if (table_id && triggering_row_id) {
    const table = Table.findOne(table_id);
    const pk = table?.pk_name;
    if (table) triggering_row = await table.getRow({ [pk]: triggering_row_id });
  }
  if (!run_id || run_id === "undefined") {
    const ini_interacts = await get_initial_interactions(
      action.configuration,
      req.user,
      triggering_row,
    );
    run = await WorkflowRun.create({
      status: "Running",
      started_by: req.user?.id,
      trigger_id: config.action_id,
      context: {
        implemented_fcall_ids: [],
        interactions: [...ini_interacts],
        html_interactions: [],
        funcalls: {},
        triggering_row_id,
      },
    });
  } else {
    run = await WorkflowRun.findOne({ id: +run_id });
  }
  let fileBadges = "";
  if (config.image_upload && req.files?.file) {
    const rawFiles = Array.isArray(req.files.file)
      ? req.files.file
      : [req.files.file];
    const badges = [];
    for (const rawFile of rawFiles) {
      const file = await File.from_req_files(
        rawFile,
        req.user ? req.user.id : null,
        100,
      );
      badges.push(
        div(
          { class: "bg-secondary-subtle p-2 m-2 rounded-2" },
          img({
            src: `/files/resize/${50}/${50}/${file.path_to_serve}`,
            class: "d-block",
            onclick: `expand_thumbnail('${file.path_to_serve}', '${path.basename(file.path_to_serve)}')`,
          }),
          file.filename,
        ),
      );
      const baseUrl = getState().getConfig("base_url").replace(/\/$/, "");
      let imageurl;
      if (
        !config.image_base64 &&
        baseUrl &&
        !baseUrl.includes("http://localhost:")
      ) {
        imageurl = `${baseUrl}/files/serve/${file.path_to_serve}`;
      } else {
        const b64 = await file.get_contents("base64");
        imageurl = `data:${file.mimetype};base64,${b64}`;
      }
      await getState().functions.llm_add_message.run("image", imageurl, {
        chat: run.context.interactions || [],
      });
    }
    await saveInteractions(run);
    fileBadges = div({ class: "d-flex" }, badges);
  }
  const userInteractions = wrapSegment(
    p(escapeHtml(userinput)) + fileBadges,
    "You",
    true,
    config.layout,
  );

  await addToContext(run, {
    interactions: [
      ...(run.context.interactions || []),
      { role: "user", content: userinput },
    ],
    html_interactions: [userInteractions],
  });
  const dyn_updates = getState().getConfig("enable_dynamic_updates", true);
  if (dyn_updates) {
    getState().emitDynamicUpdate(
      db.getTenantSchema(),
      {
        eval_js: `processCopilotResponse({response: ${JSON.stringify(userInteractions)}, run_id: ${run.id}}, true)`,
        page_load_tag: req?.headers?.["page-load-tag"],
      },
      [req.user.id],
    );
  }
  const process_promise = process_interaction(
    run,
    action.configuration,
    req,
    action.name,
    [],
    triggering_row,
    config,
    dyn_updates,
  );
  if (dyn_updates) {
    process_promise.catch((e) => {
      console.error(e);
      getState().emitDynamicUpdate(
        db.getTenantSchema(),
        {
          error: e?.message || e,
          page_load_tag: req?.headers?.["page-load-tag"],
        },
        [req.user.id],
      );
    });
    return { json: { dyn_updates }};
  } else return await process_promise;
};

const delprevrun = async (table_id, viewname, config, body, { req, res }) => {
  const { run_id } = body;
  let run;

  run = await WorkflowRun.findOne({ id: +run_id });
  if (req.user?.role_id === 1 || req.user?.id === run.started_by)
    await run.delete();

  return;
};

const debug_info = async (table_id, viewname, config, body, { req, res }) => {
  const { run_id, triggering_row_id } = body;
  const action =
    config.agent_action || (await Trigger.findOne({ id: config.action_id }));
  let triggering_row;
  if (table_id && triggering_row_id) {
    const table = Table.findOne(table_id);
    const pk = table?.pk_name;
    if (table) triggering_row = await table.getRow({ [pk]: triggering_row_id });
  }
  const run = await WorkflowRun.findOne({ id: +run_id });
  let sysPrompt = "";
  if (
    run.context.api_interactions?.[0].request?.messages?.[0]?.role === "system"
  ) {
    sysPrompt =
      run.context.api_interactions?.[0].request?.messages?.[0].content;
  } else {
    const complArgs = await getCompletionArguments(
      action.configuration,
      req.user,
      triggering_row,
    );
    sysPrompt = complArgs.systemPrompt;
  }
  const debug_html = div(
    div(h4("System prompt"), pre(text(escapeHtml(sysPrompt)))),
    div(
      h4("API interactions"),
      pre(
        text(escapeHtml(JSON.stringify(run.context.api_interactions, null, 2))),
      ),
    ),
  );
  if (run && req.user?.role_id === 1)
    return {
      json: {
        success: "ok",
        debug_html,
      },
    };

  return;
};

const skillroute = async (table_id, viewname, config, body, { req, res }) => {
  const { run_id, triggering_row_id, skillid } = body;
  const action =
    config.agent_action || (await Trigger.findOne({ id: config.action_id }));
  let triggering_row;
  if (table_id && triggering_row_id) {
    const table = Table.findOne(table_id);
    const pk = table?.pk_name;
    if (table) triggering_row = await table.getRow({ [pk]: triggering_row_id });
  }
  const run = await WorkflowRun.findOne({ id: +run_id });
  if (!run) return;

  const instances = get_skill_instances(action.configuration);
  const instance = instances.find((i) => i.skillid === skillid);

  if (!instance?.skillRoute) return;
  const resp = await instance.skillRoute({
    triggering_row,
    run,
    req,
    user: req.user,
  });
  return {
    json: {
      success: "ok",
      ...resp,
    },
  };
};

const execute_user_action = async (
  table_id,
  viewname,
  config,
  body,
  { req, res },
) => {
  const { run_id, rndid, uaname } = body;

  const action =
    config.agent_action || (await Trigger.findOne({ id: config.action_id }));
  const run = await WorkflowRun.findOne({ id: +run_id });
  //console.log("run uas",run.context.user_actions );

  if (!run) return;
  const instances = get_skill_instances(action.configuration);
  const instance = instances.find((i) => i.userActions?.[uaname]);
  //console.log({ instance });

  if (!instance) return;
  const uadata = (run.context.user_actions || []).find(
    (ua) => ua.rndid === rndid,
  );
  if (!uadata) return;
  const result = await instance.userActions[uaname]({
    user: req.user,
    ...uadata.tool_call.input,
    ...uadata.input,
  });
  return {
    json: {
      success: "ok",
      ...result,
    },
  };
};

module.exports = {
  name: "Agent Chat",
  configuration_workflow,
  display_state_form: false,
  get_state_fields,
  //tableless: true,
  table_optional: true,
  run,
  routes: { interact, delprevrun, debug_info, skillroute, execute_user_action },
  mobile_render_server_side: true,
};
