const agent1 = {
  model: "",
  prompt: "{{theprompt}}",
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
    {
      mode: "Tool",
      list_view: "",
      doc_format: "",
      skill_type: "Retrieval by full-text search",
      table_name: "books",
      hidden_fields: "",
      add_sys_prompt:
        "Use this tool to search information about books in a book database. Each book is indexed by author and has page counts. If the user asks for information about books by a specific author, use this tool.",
    },
    {
      agent_name: "MathsAgent",
      skill_type: "Subagent",
    },
  ],
  sys_prompt: "",
};

const maths_agent_cfg = {
  model: "",
  prompt: "{{theprompt}}",
  skills: [
    {
      tool_name: "generate_arithmetic_code",
      skill_type: "Generate and run JavaScript code",
      add_sys_prompt: "",
      code_description: "",
      tool_description: "Generate Javascript code to solve arithmetic problems",
    },
  ],
  sys_prompt:
    "If the user asks an arithmetic question, generate javascript code to solve it with the generate_arithmetic_code tool",
};

const oracle_agent_cfg = {
  model: "",
  prompt: "{{theprompt}}",
  skills: [
    {
      tool_name: "ask_the_oracle",
      tool_description: "Ask the all-knowing oracle a question",
      skill_type: "Run JavaScript code",
      js_code: "return '987';",
      toolargs: [
        {
          name: "question",
          description: "The question you would like to ask",
          argtype: "string",
        },
      ],
    },
  ],
  sys_prompt:
    "You can ask a question of the all-knowing oracle by calling the ask_the_oracle tool ",
};

module.exports = { agent1, maths_agent_cfg, oracle_agent_cfg };
