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
} = require("./common");
const MarkdownIt = require("markdown-it"),
  md = new MarkdownIt();

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
                    "Configure"
                  ),
              },
              {
                name: "show_prev_runs",
                label: "Show previous runs",
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
                name: "image_upload",
                label: "Upload images",
                sublabel: "Allow the user to upload images",
                type: "Bool",
              },
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

const get_state_fields = () => [];

const uploadForm = (viewname, req) =>
  span(
    {
      class: "attach_agent_image_wrap",
    },
    label(
      { class: "btn-link", for: "attach_agent_image" },
      i({ class: "fas fa-paperclip" })
    ),
    input({
      id: "attach_agent_image",
      name: "file",
      type: "file",
      class: "d-none",
      accept: "image/*",
      onchange: `agent_file_attach(event)`,
    }),
    span({ class: "ms-2 filename-label" })
  );

const run = async (
  table_id,
  viewname,
  { action_id, show_prev_runs, placeholder, explainer, image_upload },
  state,
  { res, req }
) => {
  const action = await Trigger.findOne({ id: action_id });
  const prevRuns = (
    await WorkflowRun.find(
      { trigger_id: action.id, started_by: req.user?.id },
      { orderBy: "started_at", orderDesc: true, limit: 30 }
    )
  ).filter((r) => r.context.interactions);

  const cfgMsg = incompleteCfgMsg();
  if (cfgMsg) return cfgMsg;
  let runInteractions = "";
  if (state.run_id) {
    const run = prevRuns.find((r) => r.id == state.run_id);
    const interactMarkups = [];
    for (const interact of run.context.interactions) {
      switch (interact.role) {
        case "user":
          if (interact.content?.[0]?.type === "image_url") {
            const image_url = interact.content[0].image_url.url;
            if (image_url.startsWith("data"))
              interactMarkups.push(
                div(
                  { class: "interaction-segment" },
                  span({ class: "badge bg-secondary" }, "You"),
                  "File"
                )
              );
            else
              interactMarkups.push(
                div(
                  { class: "interaction-segment" },
                  span({ class: "badge bg-secondary" }, "You"),
                  a({ href: image_url, target: "_blank" }, "File")
                )
              );
          } else
            interactMarkups.push(
              div(
                { class: "interaction-segment" },
                span({ class: "badge bg-secondary" }, "You"),
                md.render(interact.content)
              )
            );
          break;
        case "assistant":
        case "system":

          for (const tool_call of interact.tool_calls || []) {
            const toolSkill = find_tool(
              tool_call.function.name,
              action.configuration
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
                        rendered
                      ),
                      action.name
                    )
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
                  }
                );

                if (rendered)
                  interactMarkups.push(
                    wrapSegment(
                      wrapCard(
                        toolSkill.skill.skill_label ||
                          toolSkill.skill.constructor.skill_name,
                        rendered
                      ),
                      action.name
                    )
                  );
              }
            }
          }

          interactMarkups.push(
            div(
              { class: "interaction-segment" },
              span({ class: "badge bg-secondary" }, action.name),
              typeof interact.content === "string"
                ? md.render(interact.content)
                : typeof interact.content?.content === "string"
                ? md.render(interact.content.content)
                : interact.content
            )
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
                  }
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
                    markupContent
                  ),
                  action.name
                )
              );
          }
          break;
      }
    }
    runInteractions = interactMarkups.join("");
  }
  const input_form = form(
    {
      onsubmit: `event.preventDefault();spin_send_button();view_post('${viewname}', 'interact', new FormData(this), processCopilotResponse);return false;`,
      class: "form-namespace copilot mt-2",
      method: "post",
    },
    input({
      type: "hidden",
      name: "_csrf",
      value: req.csrfToken(),
    }),
    input({
      type: "hidden",
      class: "form-control  ",
      name: "run_id",
      value: state.run_id ? +state.run_id : undefined,
    }),
    div(
      { class: "copilot-entry" },
      textarea({
        class: "form-control",
        name: "userinput",
        "data-fieldname": "userinput",
        placeholder: placeholder || "How can I help you?",
        id: "inputuserinput",
        rows: "3",
        autofocus: true,
      }),
      span(
        { class: "submit-button p-2", onclick: "$('form.copilot').submit()" },
        i({ id: "sendbuttonicon", class: "far fa-paper-plane" })
      ),
      image_upload && uploadForm(viewname, req),
      explainer && small({ class: "explainer" }, i(explainer))
    )
  );

  const prev_runs_side_bar = div(
    div(
      {
        class: "d-flex justify-content-between align-middle mb-2",
      },
      h5("Sessions"),

      button(
        {
          type: "button",
          class: "btn btn-secondary btn-sm py-0",
          style: "font-size: 0.9em;height:1.5em",
          onclick: "unset_state_field('run_id')",
          title: "New session",
        },
        i({ class: "fas fa-redo fa-sm" })
      )
    ),
    prevRuns.map((run) =>
      div(
        {
          onclick: `set_state_field('run_id',${run.id})`,
          class: "prevcopilotrun border p-2",
        },
        div(
          { class: "d-flex justify-content-between" },
          localeDateTime(run.started_at),
          i({
            class: "far fa-trash-alt",
            onclick: `delprevrun(event, ${run.id})`,
          })
        ),

        p({ class: "prevrun_content" }, run.context.interactions[0]?.content)
      )
    )
  );
  const main_chat = div(
    { class: "card" },
    div(
      { class: "card-body" },
      div({ id: "copilotinteractions" }, runInteractions),
      input_form,
      style(
        `div.interaction-segment:not(:first-child) {border-top: 1px solid #e7e7e7; }
              div.interaction-segment {padding-top: 5px;padding-bottom: 5px;}
              div.interaction-segment p {margin-bottom: 0px;}
              div.interaction-segment div.card {margin-top: 0.5rem;}            
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
              .copilot-entry span.attach_agent_image_wrap {
              position: relative; 
              top: -1.8rem;
              left: 0.2rem;              
            }
              .copilot-entry .explainer {
              position: relative; 
              top: -1.2rem;    
              display: block;                        
            }
            .copilot-entry {margin-bottom: -1.25rem; margin-top: 1rem;}
            p.prevrun_content {
               white-space: nowrap;
    overflow: hidden;
    margin-bottom: 0px;
    display: block;
    text-overflow: ellipsis;}`
      ),
      script(`function processCopilotResponse(res) {
        const hadFile = $("input#attach_agent_image").val();
        $("span.filename-label").text("");
        $("input#attach_agent_image").val(null);
        $("#sendbuttonicon").attr("class","far fa-paper-plane");
        const $runidin= $("input[name=run_id")
        if(res.run_id && (!$runidin.val() || $runidin.val()=="undefined"))
          $runidin.val(res.run_id);
        const wrapSegment = (html, who) => '<div class="interaction-segment"><span class="badge bg-secondary">'+who+'</span>'+html+'</div>'
        $("#copilotinteractions").append(wrapSegment('<p>'+$("textarea[name=userinput]").val()+'</p>', "You"))
        if(hadFile)
          $("#copilotinteractions").append(wrapSegment('File', "You"))
        $("textarea[name=userinput]").val("")

        if(res.response)
            $("#copilotinteractions").append(res.response)
    }
    function agent_file_attach(e) {
        $(".attach_agent_image_wrap span.filename-label").text(e.target.files[0].name)
    }
    function restore_old_button_elem(btn) {
        const oldText = $(btn).data("old-text");
        btn.html(oldText);
        btn.css({ width: "" }).prop("disabled", false);
        btn.removeData("old-text");
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
        if (event.which === 13) {
            if (!event.repeat) {
                const newEvent = new Event("submit", {cancelable: true});
                event.target.form.dispatchEvent(newEvent);
            }

            event.preventDefault(); // Prevents the addition of a new line in the text field
        }        
    }
    document.getElementById("inputuserinput").addEventListener("keydown", submitOnEnter);
    function spin_send_button() {
      $("#sendbuttonicon").attr("class","fas fa-spinner fa-spin");
    }
`)
    )
  );
  return show_prev_runs
    ? {
        widths: [3, 9],
        gx: 3,
        besides: [
          {
            type: "container",
            contents: prev_runs_side_bar,
          },
          {
            type: "container",
            contents: main_chat,
          },
        ],
      }
    : main_chat;
};

const interact = async (table_id, viewname, config, body, { req, res }) => {
  const { userinput, run_id } = body;
  let run;
  if (!run_id || run_id === "undefined")
    run = await WorkflowRun.create({
      status: "Running",
      started_by: req.user?.id,
      trigger_id: config.action_id,
      context: {
        implemented_fcall_ids: [],
        interactions: [{ role: "user", content: userinput }],
        funcalls: {},
      },
    });
  else {
    run = await WorkflowRun.findOne({ id: +run_id });
    await addToContext(run, {
      interactions: [{ role: "user", content: userinput }],
    });
  }
  if (config.image_upload && req.files?.file) {
    const file = await File.from_req_files(
      req.files.file,
      req.user ? req.user.id : null,
      100
      // file_field?.attributes?.folder
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
    await addToContext(run, {
      interactions: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: imageurl,
              },
            },
          ],
        },
      ],
    });
  }
  const action = await Trigger.findOne({ id: config.action_id });

  return await process_interaction(run, action.configuration, req, action.name);
};

const delprevrun = async (table_id, viewname, config, body, { req, res }) => {
  const { run_id } = body;
  let run;

  run = await WorkflowRun.findOne({ id: +run_id });
  if (req.user?.role_id === 1 || req.user?.id === run.started_by)
    await run.delete();

  return;
};

const wrapAction = (
  inner_markup,
  viewname,
  tool_call,
  actionClass,
  implemented,
  run
) =>
  wrapCard(
    actionClass.title,
    inner_markup + implemented
      ? button(
          {
            type: "button",
            class: "btn btn-secondary d-block mt-3 float-end",
            disabled: true,
          },
          i({ class: "fas fa-check me-1" }),
          "Applied"
        )
      : button(
          {
            type: "button",
            id: "exec-" + tool_call.id,
            class: "btn btn-primary d-block mt-3 float-end",
            onclick: `press_store_button(this, true);view_post('${viewname}', 'execute', {fcall_id: '${tool_call.id}', run_id: ${run.id}}, processExecuteResponse)`,
          },
          "Apply"
        ) + div({ id: "postexec-" + tool_call.id })
  );

module.exports = {
  name: "Agent Chat",
  configuration_workflow,
  display_state_form: false,
  get_state_fields,
  tableless: true,
  run,
  routes: { interact, delprevrun },
};
