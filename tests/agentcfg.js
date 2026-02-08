module.exports = {
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
  ],
  sys_prompt: "",
};
