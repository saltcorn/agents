const { div, button, input, label } = require("@saltcorn/markup/tags");

// Everything below sits inside a double-quoted HTML attribute, so it must not
// contain a double quote of its own - the attribute would end there and the
// handler would be truncated.
const user_action_onclick = (ua, viewname, run, ua_input_js) =>
  `view_post(${
    viewname
      ? `'${viewname}'`
      : `$(this).closest('[data-sc-embed-viewname]').attr('data-sc-embed-viewname')`
  }, 'execute_user_action', {uaname: '${ua.name}', rndid: '${ua.rndid}', run_id: ${
    run.id
  }${
    ua_input_js ? `, ua_input: ${ua_input_js}` : ""
  }}, processExecuteResponse)`;

// A user action the skill wants answered with a radio group rather than a row
// of buttons: for a handful of long options, buttons do not fit. The chosen
// value is read out of the group when the submit button is pressed and sent as
// ua_input, so the answer is not known when this is rendered.
const user_action_radio_html = (ua, viewname, run) => {
  const group = `ua-${ua.rndid}`;
  const checked_val = `$(this).closest('[data-useraction-id]').find('input:checked')`;
  return div(
    { "data-useraction-id": ua.rndid, class: "mb-2" },
    (ua.options || []).map((opt, ix) =>
      div(
        { class: "form-check" },
        input({
          type: "radio",
          class: "form-check-input",
          name: group,
          id: `${group}-${ix}`,
          value: opt.value,
        }),
        label(
          { class: "form-check-label", for: `${group}-${ix}` },
          opt.label,
          opt.description
            ? div({ class: "small text-muted" }, opt.description)
            : "",
        ),
      ),
    ),
    button(
      {
        class: ua.class || "btn btn-primary mt-2",
        onclick: `if(!${checked_val}.length) return false; ${user_action_onclick(
          ua,
          viewname,
          run,
          `{choice: ${checked_val}.val()}`,
        )}`,
      },
      ua.submit_label || "Submit",
    ),
  );
};

// The buttons (or radio groups) a skill has attached to a tool call. Buttons
// sit next to each other, a radio group is laid out down the page
const user_actions_html = (user_actions, viewname, run) =>
  div(
    {
      class: user_actions.some((ua) => ua.type === "radio_group")
        ? "mb-2"
        : "d-flex flex-wrap gap-2 mb-2",
    },
    user_actions.map((ua) =>
      ua.type === "radio_group"
        ? user_action_radio_html(ua, viewname, run)
        : button(
            {
              "data-useraction-id": ua.rndid,
              class: ua.class || "btn btn-primary", //press_store_button(this, true);
              ...(ua.title ? { title: ua.title } : {}),
              onclick: user_action_onclick(ua, viewname, run),
            },
            ua.label,
          ),
    ),
  );

module.exports = {
  user_action_onclick,
  user_action_radio_html,
  user_actions_html,
};
