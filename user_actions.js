const {
  div,
  button,
  input,
  label,
  ul,
  li,
  textarea,
} = require("@saltcorn/markup/tags");

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

// One question in a form: a radio group, a set of checkboxes or a text box.
// Each input is named after the user action and the question, so that several
// forms on the page do not interfere with each other
const form_question_html = (ua, q, qix, hidden) => {
  const name = `ua-${ua.rndid}-${qix}`;
  const choices = (type) =>
    (q.options || []).map((opt, oix) =>
      div(
        { class: "form-check" },
        input({
          type,
          class: "form-check-input",
          name,
          id: `${name}-${oix}`,
          value: `${oix}`,
        }),
        label(
          { class: "form-check-label", for: `${name}-${oix}` },
          opt.label,
          opt.description
            ? div({ class: "small text-muted" }, opt.description)
            : "",
        ),
      ),
    );
  return div(
    {
      class: ["ua-question-pane", "mb-2", hidden && "d-none"],
      "data-question-ix": qix,
      "data-question-type": q.type,
    },
    q.show_question ? div({ class: "fw-bold mb-2" }, q.question) : "",
    q.type === "free_text"
      ? textarea({
          class: "form-control",
          name,
          rows: 3,
          "aria-label": q.header,
        })
      : choices(q.type === "multi_select" ? "checkbox" : "radio"),
  );
};

// Reads the answers out of a form, one per question: the index picked in a
// radio group, the list of indices ticked, or the text written. A radio group
// left unanswered stops the submit, and its tab is brought to the front.
// Single quotes only, as this ends up in a double-quoted onclick attribute.
const form_answers_js = `var w=$(this).closest('[data-useraction-id]');var a=[];var miss=-1;w.find('.ua-question-pane').each(function(i){var p=$(this);var t=p.attr('data-question-type');if(t==='free_text')a.push(p.find('textarea').val()||'');else if(t==='multi_select')a.push(p.find('input:checked').map(function(){return this.value;}).get());else{var v=p.find('input:checked').val();if(typeof v==='undefined'&&miss<0)miss=i;a.push(typeof v==='undefined'?null:v);}});if(miss>=0){w.find('.ua-question-tab').eq(miss).click();return false;}`;

// Shows one question of a tabbed form and hides the others
const show_tab_js = (qix) =>
  `var w=$(this).closest('[data-useraction-id]');w.find('.ua-question-tab').removeClass('active');$(this).addClass('active');w.find('.ua-question-pane').addClass('d-none');w.find('.ua-question-pane[data-question-ix=${qix}]').removeClass('d-none');return false;`;

// A user action answered with a form of one or more questions, each of which
// may be single choice, multiple choice or free text. With more than one
// question they are put in tabs, headed by the short header the skill gives.
// All the answers are sent together when the submit button is pressed
const user_action_form_html = (ua, viewname, run) => {
  const questions = ua.questions || [];
  const tabbed = questions.length > 1;
  return div(
    { "data-useraction-id": ua.rndid, class: "mb-2" },
    tabbed
      ? ul(
          { class: "nav nav-tabs mb-2" },
          questions.map((q, qix) =>
            li(
              { class: "nav-item" },
              button(
                {
                  type: "button",
                  class: ["nav-link", "ua-question-tab", qix === 0 && "active"],
                  ...(q.question ? { title: q.question } : {}),
                  onclick: show_tab_js(qix),
                },
                q.header,
              ),
            ),
          ),
        )
      : "",
    questions.map((q, qix) =>
      form_question_html(
        ua,
        { ...q, show_question: tabbed },
        qix,
        tabbed && qix > 0,
      ),
    ),
    button(
      {
        type: "button",
        class: ua.class || "btn btn-primary mt-2",
        onclick: `${form_answers_js} ${user_action_onclick(
          ua,
          viewname,
          run,
          `{answers: a}`,
        )}`,
      },
      ua.submit_label || "Submit",
    ),
  );
};

// The buttons (or radio groups, or forms) a skill has attached to a tool call.
// Buttons sit next to each other, the others are laid out down the page
const user_actions_html = (user_actions, viewname, run) =>
  div(
    {
      class: user_actions.some((ua) => ua.type && ua.type !== "button")
        ? "mb-2"
        : "d-flex flex-wrap gap-2 mb-2",
    },
    user_actions.map((ua) =>
      ua.type === "radio_group"
        ? user_action_radio_html(ua, viewname, run)
        : ua.type === "form"
          ? user_action_form_html(ua, viewname, run)
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
  user_action_form_html,
  user_actions_html,
};
