const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { select, option } = require("@saltcorn/markup/tags");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { validID } = require("@saltcorn/markup/layout_utils");
const { features } = require("@saltcorn/data/db/state");

class PromptPicker {
  static skill_name = "Prompt picker";
  get skill_label() {
    return `Prompt picker`;
  }
  constructor(cfg) {
    Object.assign(this, cfg);
    if (this.source === "Table") {
      this.formname = validID("pp" + Object.keys(this.table));
      return;
    }
    if (this.options_array) {
      this.options = {};
      this.options_array.forEach((o) => {
        this.options[o.promptpicker_label] = o.promptpicker_sysprompt;
      });
    } else if (this.options_obj)
      this.options = eval_expression(
        this.options_obj,
        {},
        null,
        "Prompt picker options",
      );
    this.formname = validID("pp" + Object.keys(this.options));
  }
  static async configFields() {
    const allTables = await Table.find({}, { cached: true });
    const stringFieldOptions = {};
    for (const table of allTables) {
      stringFieldOptions[table.name] = table.fields
        .filter((f) => f?.type?.name === "String")
        .map((f) => f.name);
    }
    return [
      { name: "placeholder", label: "Placeholder", type: "String" },
      {
        name: "source",
        label: "Source",
        type: "String",
        required: true,
        attributes: { options: ["Predefined", "Table"] },
      },
      {
        name: "run_on_select",
        label: "To user input",
        type: "Bool",
        sublabel:
          "If checked, selection will be added to the user input. If unchecked, the selected value will be added to the system prompt",
      },
      {
        name: "editable",
        label: "Editable",
        type: "Bool",
        showIf: { run_on_select: true },
        sublabel:
          "If checked, the prompt can be edited by the user who can ten submit. Unchecked get sent immediately",
      },
      {
        name: "table",
        label: "Table",
        type: "String",
        required: true,
        showIf: { source: "Table" },
        attributes: { options: allTables.map((t) => t.name) },
      },
      {
        name: "label_field",
        label: "Label field",
        type: "String",
        required: true,
        showIf: { source: "Table" },
        attributes: { calcOptions: ["table", stringFieldOptions] },
      },
      {
        name: "prompt_field",
        label: "Prompt field",
        type: "String",
        required: true,
        showIf: { source: "Table" },
        attributes: { calcOptions: ["table", stringFieldOptions] },
      },
      {
        name: "query",
        label: "Query",
        type: "String",
        class: "validate-expression",
        showIf: { source: "Table" },
        sublabel: "Optional. Only use rows that match this query",
      },
      features.nested_fieldrepeats
        ? new FieldRepeat({
            name: "options_array",
            showIf: { source: "Predefined" },
            fields: [
              {
                name: "promptpicker_label",
                label: "Label",
                type: "String",
              },
              {
                name: "promptpicker_sysprompt",
                label: "System prompt",
                type: "String",
                fieldview: "textarea",
              },
            ],
          })
        : {
            name: "options_obj",
            label: "System prompt contents",
            sublabel: `JavaScript object where the keys are the options and values are added to system prompt. Example:<br><code>{"Pirate":"Speak like a pirate", "Pop star":"Speak like a pop star"}</code>`,
            type: "String",
            fieldview: "textarea",
            showIf: { source: "Predefined" },
            required: true,
          },
    ];
  }
  async formWidget({ user, klass }) {
    let options;
    if (this.source === "Table") {
      const table = Table.findOne({ name: this.table });
      const rows = await table.getRows(
        this.query
          ? eval_expression(this.query, {}, user, "PromptPicker query")
          : {},
        { forUser: user, forPublic: !user },
      );
      options = rows.map((r) =>
        option({ value: r[this.prompt_field] }, r[this.label_field]),
      );
    } else options = Object.keys(this.options).map((o) => option(o));

    return select(
      {
        class: ["form-select form-select-sm w-unset", klass],
        name: this.formname,
        onchange: this.run_on_select
          ? `$('textarea[name=userinput]').val($('textarea[name=userinput]').val()+this.value)${this.editable ? ".focus().trigger('update.autogrow');" : `.closest('form').submit(); $(this).prop('selectedIndex', 0).blur()`}`
          : undefined,
      },
      (this.placeholder || this.run_on_select) &&
        option(
          { disabled: true, selected: true },
          this.placeholder || "Select a prompt",
        ),
      options,
    );
  }
  systemPrompt(body) {
    if (body[this.formname] && !this.run_on_select)
      return this.options[body[this.formname]];
  }
}

module.exports = PromptPicker;
