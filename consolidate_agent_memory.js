const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const { p } = require("@saltcorn/markup/tags");
const { get_skills, process_interaction, wrapSegment } = require("./common");
const { applyAsync } = require("@saltcorn/data/utils");
const WorkflowRun = require("@saltcorn/data/models/workflow_run");
const { interpolate, escapeHtml } = require("@saltcorn/data/utils");
const { getState } = require("@saltcorn/data/db/state");

module.exports = {
  //configFields: async ({ table, mode }) => [],
  run: async ({ configuration, user, table, req, ...rest }) => {
    const memtable = Table.findOne("AgentLongTermMemory");
    if (!memtable) return;
    // write personal preferences

    // get all personal observations
    const personalmems = await memtable.getRows(
      { personal: true },
      { orderBy: "written_at" },
    );

    const user_ids = new Set(personalmems.map((p) => p.user_id));

    for (const uid of user_ids.values()) {
      const all_umems = personalmems.filter((m) => m.user_id === uid);
      const existingPP = all_umems.find(
        (m) => m.memory_type === "PersonalPreferences",
      );
      const nonPPs = all_umems.filter(
        (m) => m.memory_type !== "PersonalPreferences",
      );

      if (
        existingPP &&
        nonPPs.every((m) => m.written_at < existingPP.written_at)
      )
        continue; // no new memories
      const prompt = `This is a set of observations about a user:
${nonPPs.map((m) => `* ${m.contents}`).join("\n")}

They are in ascending chronological order so if there are any contradictions, the latter observation take precedence.

Write a succinct summary of these observations which captures all the essential facts. Start the summary with the words
"The user..." (in the language in which the observations appear) and then write what you have learned about the user.`;

      const answer = await getState().functions.llm_generate.run(prompt);

      if (answer && typeof answer === "string") {
        await memtable.deleteRows({
          memory_type: "PersonalPreferences",
          user_id: uid,
        });
        await memtable.insertRow({
          user_id: uid,
          written_at: new Date(),
          memory_type: "PersonalPreferences",
          contents: answer,
          personal: true,
        });
      }
    }
  },
};
