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
  h2,
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
const fs = require("fs");

const configuration_workflow = (req) =>
  new Workflow({
    steps: [
      {
        name: "Agent action",
        form: async (context) => {
          let run_id_field_opts;
          if (context.table_id) {
            const table = Table.findOne({ id: context.table_id });
            run_id_field_opts = table.fields
              .filter((f) => f.type?.name === "Integer" && !f.primary_key)
              .map((f) => f.name);
          }

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
              ...(run_id_field_opts
                ? [
                    {
                      name: "run_id_field",
                      type: "String",
                      label: "Run ID field",
                      sublabel: "Set this field to the run ID",
                      attributes: { options: run_id_field_opts },
                    },
                  ]
                : []),
              {
                name: "shared",
                label: "Shared runs",
                sublabel: "Users can open runs created by other users",
                type: "Bool",
              },
              {
                name: "layout",
                label: "Layout",
                type: "String",
                required: true,
                attributes: {
                  options: [
                    "Standard",
                    "No card",
                    "Modern chat",
                    "Modern chat - no card",
                  ],
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
          $(".agent-waiting-indicator").remove();
          window['stream scratch ${viewname} ${rndid}'].push(data.content)
          const rendered = md.render(window['stream scratch ${viewname} ${rndid}'].join(""));
          $('div.next_response_scratch').html(
            (${JSON.stringify(layout || "")} || "").startsWith("Modern chat")
              ? '<div class="chat-message chat-assistant"><div class="chat-avatar"><i class="fas fa-robot"></i></div><div class="chat-bubble">' + rendered + '</div></div>'
              : rendered
          );
          scrollAgentToBottom();
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

const agents_css = fs.readFileSync(
  path.resolve(__dirname, "agents.css"),
  "utf8",
);

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
    shared,
  },
  state,
  { res, req },
) => {
  const action = agent_action || (await Trigger.findOne({ id: action_id }));
  if (!action) throw new Error(`Action not found: ${action_id}`);
  let triggering_row_id;
  if (table_id) {
    const table = Table.findOne(table_id);
    const pk = table?.pk_name;
    if (table && state[pk])
      //triggering_row = await table.getRow({ [pk]: state[pk] });
      triggering_row_id = state[pk];
  }
  const prevRuns = show_prev_runs
    ? (
        await WorkflowRun.find(
          {
            trigger_id: action.id,
            ...(shared ? {} : { started_by: req.user?.id }),
            ...(triggering_row_id
              ? { context: { json: ["triggering_row_id", triggering_row_id] } }
              : {}),
          },
          { orderBy: "started_at", orderDesc: true, limit: 30 },
        )
      ).filter((r) => r.context.interactions)
    : null;

  const cfgMsg = incompleteCfgMsg();
  if (cfgMsg) return cfgMsg;
  let runInteractions = "";

  const initial_q = state.run_id ? undefined : state._q;
  if (state.run_id) {
    let run = prevRuns ? prevRuns.find((r) => r.id == state.run_id) : null;
    if (!run)
      run = await WorkflowRun.findOne({
        trigger_id: action.id,
        ...(shared ? {} : { started_by: req.user?.id }),
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
                interactMarkups.push(wrapSegment("File", "You", true, layout));
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
                wrapSegment(md.render(interact.content), "You", true, layout),
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
      onsubmit: `event.preventDefault();const _fd=new FormData(this);spin_send_button();view_post('${viewname}', 'interact', _fd, ${dyn_updates ? "null" : "processCopilotResponse"});return false;`,
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
      button(
        {
          type: "button",
          class: "btn btn-xs btn-sm btn-outline-secondary cancelbtn ms-2",
          onclick: "press_cancel_button()",
          style: { display: "none" },
        },
        i({ class: "fas fa-stop" }),
      ),
      explainer && small({ class: "explainer" }, i(explainer)),
    ),
    stream && realTimeCollabScript(viewname, rndid, layout),
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
                  onclick: "unset_state_field('run_id', this)",
                  title: "New chat",
                },
                i({ class: "fas fa-plus me-1" }),
                "New",
              ),
            )
          : div(
              {
                class:
                  "d-flex flex-wrap justify-content-between align-middle mb-2",
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
                  onclick: "unset_state_field('run_id', this)",
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
                  onclick: `set_state_field('run_id',${run.id}, this)`,
                  class:
                    "prevcopilotrun modern-session-item" +
                    (isActive ? " active-session" : ""),
                },
                div(
                  {
                    class:
                      "d-flex justify-content-between align-items-center mb-1",
                  },
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
                  onclick: `set_state_field('run_id',${run.id}, this)`,
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
                p({ class: "prevrun_content" }, preview),
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
    stream ? div({ class: "next_response_scratch" }) : "",
    input_form,
    style(agents_css),
    script(domReady(`$( "#inputuserinput" ).autogrow({paddingBottom: 20});`)),
    script(
      `
    function scrollAgentToBottom() {
      const container = document.getElementById('copilotinteractions');
      if (container) {
        if (container.scrollHeight > container.clientHeight) {
          container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        }
        const inputForm = document.querySelector('form.agent-view');
        if (inputForm) inputForm.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    }
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
        if(!not_final || (!${JSON.stringify(dyn_updates)})) {
          $("#sendbuttonicon").attr("class","far fa-paper-plane");
          $(".cancelbtn").hide();
        }
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
        $('div.next_response_scratch').html("")
        window['stream scratch ${viewname} ${rndid}'] = []
        if(res.response) {
            $(".agent-waiting-indicator").remove();
            $("#copilotinteractions").append(res.response);
            scrollAgentToBottom();
        }
    }
    window.processCopilotResponse = processCopilotResponse;
    window.final_agent_response = () => {
      $("#sendbuttonicon").attr("class","far fa-paper-plane");
      $(".agent-waiting-indicator").remove();
      $("textarea[name=userinput]").prop("disabled", false).attr("placeholder", ${JSON.stringify(placeholder || "How can I help you?")}).focus();
      $(".copilot-entry .submit-button").css("pointer-events", "");
      $(".cancelbtn").hide();
      scrollAgentToBottom();
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
    function press_cancel_button() {
        const $runidin= $("input[name=run_id")
        const runid = $runidin.val()
        if(runid)
        view_post('${viewname}', 'cancel', {run_id:runid})
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
      $(".cancelbtn").show()
      $("textarea[name=userinput]").prop("disabled", true).attr("placeholder", "Waiting for response...");
      $(".copilot-entry .submit-button").css("pointer-events", "none");
      const isModernLayout = ${JSON.stringify((layout || "").startsWith("Modern chat"))};
      const indicator = isModernLayout
        ? '<div class="agent-waiting-indicator chat-message chat-assistant"><div class="chat-avatar"><i class="fas fa-robot"></i></div><div class="chat-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div></div>'
        : '<div class="agent-waiting-indicator"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
      $('div.next_response_scratch').before(indicator);
      scrollAgentToBottom();
    };
    document.addEventListener('click', async (e) => {
  const target = e.target.closest('.copy-to-clipboard-elem');
  if (!target) return;

  // Check if the click was in the top-right corner where the icon is
  const rect = target.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;
  
  // Icon is at top: 4px, right: 4px, ~16px size — give a generous hit area
  const iconHitArea = 24;
  const isIconClick = 
    clickX >= rect.width - iconHitArea && 
    clickX <= rect.width &&
    clickY >= 0 && 
    clickY <= iconHitArea;

  if (!isIconClick) return;

  e.stopPropagation();
  e.preventDefault();

  try {
    await navigator.clipboard.writeText(target.innerText);
    target.classList.add('copy-success');
    setTimeout(() => target.classList.remove('copy-success'), 1000);
  } catch (err) {
    console.error('Failed to copy:', err);
  }
});`,
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
      ? div(
          { class: "card" },
          div({ class: "card-body modern-chat-layout" }, main_inner),
        )
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
    if (table_id && config.run_id_field && triggering_row_id) {
      const table = Table.findOne(table_id);
      await table.updateRow(
        { [config.run_id_field]: run.id },
        triggering_row_id,
      );
      if (triggering_row) triggering_row[config.run_id_field] = run.id;
    }
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
    req?.user,
  );
  await addToContext(run, {
    interactions: [
      ...(run.context.interactions || []),
      { role: "user", content: userinput },
    ],
    html_interactions: [userInteractions],
    status: "Running",
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
    return;
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

const cancel = async (table_id, viewname, config, body, { req, res }) => {
  const { run_id } = body;
  const run = await WorkflowRun.findOne({ id: +run_id });
  await run.update({ status: "Cancel" });
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
  const apiJson = JSON.stringify(run.context.api_interactions, null, 2);
  const debug_html = div(
    { class: "accordion", id: "debugAccordion" },
    div(
      { class: "accordion-item" },
      h2(
        { class: "accordion-header", id: "debugHeadPrompt" },
        button(
          {
            class: "accordion-button collapsed",
            type: "button",
            "data-bs-toggle": "collapse",
            "data-bs-target": "#debugCollapsePrompt",
            "aria-expanded": "false",
            "aria-controls": "debugCollapsePrompt",
          },
          "System prompt",
        ),
      ),
      div(
        {
          id: "debugCollapsePrompt",
          class: "accordion-collapse collapse",
          "aria-labelledby": "debugHeadPrompt",
          "data-bs-parent": "#debugAccordion",
        },
        div(
          { class: "accordion-body" },
          pre({ style: "white-space:pre-wrap" }, text(escapeHtml(sysPrompt))),
        ),
      ),
    ),
    div(
      { class: "accordion-item" },
      h2(
        { class: "accordion-header", id: "debugHeadAPI" },
        button(
          {
            class: "accordion-button",
            type: "button",
            "data-bs-toggle": "collapse",
            "data-bs-target": "#debugCollapseAPI",
            "aria-expanded": "true",
            "aria-controls": "debugCollapseAPI",
          },
          "API interactions",
        ),
      ),
      div(
        {
          id: "debugCollapseAPI",
          class: "accordion-collapse collapse show",
          "aria-labelledby": "debugHeadAPI",
          "data-bs-parent": "#debugAccordion",
        },
        div(
          { class: "accordion-body" },
          button(
            {
              class: "btn btn-sm btn-outline-secondary mb-2",
              onclick: `
                var t=document.getElementById('debugApiPre').textContent;
                navigator.clipboard.writeText(t).then(function(){
                  var b=event.target;b.textContent='Copied!';
                  setTimeout(function(){b.textContent='Copy to clipboard'},1500)
                })`,
            },
            "Copy to clipboard",
          ),
          pre(
            { id: "debugApiPre", style: "white-space:pre-wrap" },
            text(escapeHtml(apiJson)),
          ),
        ),
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
  if (result.generate_prompt) {
    const action =
      config.agent_action || (await Trigger.findOne({ id: config.action_id }));
    run.context.interactions.push({
      role: "user",
      content: result.generate_prompt,
    });
    const dyn_updates = getState().getConfig("enable_dynamic_updates", true);

    if (dyn_updates && uadata.click_replace_text) {
      const { layout } = config;

      const resp = JSON.stringify(
        wrapSegment(uadata.click_replace_text, "You", true, layout, req?.user),
      );
      getState().emitDynamicUpdate(
        db.getTenantSchema(),
        {
          eval_js: `spin_send_button();$("button[data-useraction-id=${uadata.rndid}]").replaceWith("");processCopilotResponse({response: ${resp}, run_id: ${run.id}}, true)`,
          page_load_tag: req?.headers?.["page-load-tag"],
        },
        [req.user.id],
      );
      // remove from html_interactions
      run.context.html_interactions = run.context.html_interactions.map((hi) =>
        hi.replace(
          `button data-useraction-id="${uadata.rndid}"`,
          `button style="display: none;" data-useraction-id="${uadata.rndid}"`,
        ),
      );
      run.context.html_interactions.push(
        wrapSegment(
          uadata.click_replace_text,
          "You",
          true,
          config.layout,
          req?.user,
        ),
      );
      await run.update({ context: run.context });
    }
    let row = {};
    if (run.context.triggering_row_id) {
      const table = Table.findOne(table_id);
      const pk = table?.pk_name;
      if (table)
        row = await table.getRow({ [pk]: run.context.triggering_row_id });
    }
    await process_interaction(
      run,
      action.configuration,
      req,
      action.name,
      [],
      row,
      config,
      dyn_updates,
    );
    const { generate_prompt, ...restResult } = result;
    return {
      json: {
        success: "ok",
        ...restResult,
      },
    };
  }
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
  routes: {
    interact,
    delprevrun,
    debug_info,
    skillroute,
    execute_user_action,
    cancel,
  },
  mobile_render_server_side: true,
};
