const Field = require("@saltcorn/data/models/field");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const View = require("@saltcorn/data/models/view");
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
            ],
          });
        },
      },
    ],
  });

const get_state_fields = () => [];

const run = async (
  table_id,
  viewname,
  { action_id, show_prev_runs, placeholder },
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
          if (interact.tool_calls) {
            if (interact.content) {
              interactMarkups.push(
                div(
                  { class: "interaction-segment" },
                  span({ class: "badge bg-secondary" }, action.name),
                  typeof interact.content === "string"
                    ? md.render(interact.content)
                    : interact.content
                )
              );
            }
            for (const tool_call of interact.tool_calls) {
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
          } else
            interactMarkups.push(
              div(
                { class: "interaction-segment" },
                span({ class: "badge bg-secondary" }, action.name),
                typeof interact.content === "string"
                  ? md.render(interact.content)
                  : interact.content
              )
            );
          break;
        case "tool":
          if (interact.content !== "Action run") {
            let markupContent;
            console.log("interact", interact);
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
      onsubmit: `event.preventDefault();spin_send_button();view_post('${viewname}', 'interact', $(this).serialize(), processCopilotResponse);return false;`,
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
      )
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
      script({
        src: `/static_assets/${db.connectObj.version_tag}/mermaid.min.js`,
      }),
      script(
        { type: "module" },
        `mermaid.initialize({securityLevel: 'loose'${
          getState().getLightDarkMode(req.user) === "dark"
            ? ",theme: 'dark',"
            : ""
        }});`
      ),
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

            .copilot-entry .submit-button {
              position: relative; 
              top: -1.8rem;
              left: 0.1rem;              
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
        $("#sendbuttonicon").attr("class","far fa-paper-plane");
        const $runidin= $("input[name=run_id")
        if(res.run_id && (!$runidin.val() || $runidin.val()=="undefined"))
          $runidin.val(res.run_id);
        const wrapSegment = (html, who) => '<div class="interaction-segment"><span class="badge bg-secondary">'+who+'</span>'+html+'</div>'
        $("#copilotinteractions").append(wrapSegment('<p>'+$("textarea[name=userinput]").val()+'</p>', "You"))
        $("textarea[name=userinput]").val("")      

        if(res.response)
            $("#copilotinteractions").append(res.response)
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

/*

build a workflow that asks the user for their name and age

*/

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
