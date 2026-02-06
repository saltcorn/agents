module.exports = {
  model: "",
  prompt: "theprompt",
  skills: [
    {
      mode: "Tool",
      js_code: 'return "Strawberry"',
      toolargs: [
        {
          name: "",
          argtype: "string",
          description: "",
        },
      ],
      tool_name: "word_of_the_day",
      skill_type: "Run JavaScript code",
      add_sys_prompt: "",
      tool_description: "return the word of the day",
    },
    {
      skill_type: "Prompt picker",
      placeholder: "Pick voice",
      options_array: [
        {
          promptpicker_label: "Pirate",
          promptpicker_sysprompt: "Speak like a pirate",
        },
        {
          promptpicker_label: "Lawyer",
          promptpicker_sysprompt: "Speak like a lawyer",
        },
      ],
    },
  ],
  sys_prompt: "",
};
