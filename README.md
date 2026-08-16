# agents

AI Agents for Saltcorn

To use this plugin:

1. Create an action of type Agent. Configure with system prompt and skills
2. Create a view of type Agent chat, picking that agent in the configuration

Agents are implemented as actions in the [agents](https://github.com/saltcorn/agents) plugin. An agent action is defined by enabling a number of skills, which each have a configuration. A skill is an elementary capability of an agent system. Most skills enable a tool for the LLM inference loop, but other skill change the chat behaviour.

Some examples of skills:

* A tool to query a chosen database table by matching against any field
* A Tool to making an HTTP request. 
* Expose a Javascript function written by the user
* A Tool for the AI to generate and then run Javascript code. The user chooses whether to give the code access to tables and HTTP requests.
* Long term memory - enable tools for storage and retrival into momeries stored in a database table
* MCP - connect the agent to an MCP server
* Model picker - show a dropdown to the user where they can change the inference model
* PreloadData - load data from the database into the system prompt
* Use any Saltcorn action or workflow as a tool
* Subagent - hand over to a different agent that has a different set of tools
* Web search - tool to search the internet for relevant information
* Plan approval - presents the user with a plan for solving the problem with an approval buttton in the chat. When approved, a user-defined system prompt is injected.


The agents can be run either by attaching them to events (table inserts, inbound API calls etc; in chich case an initial prompt, based on the variables in the triggering row has to be specified) or by building a view based on the Agent chat viewpatterns which is configured by picking an agent action, giving the user an interactive chat interface similar to the chatgpt interface. Previous chats can be accessed on the left in this interface, and chats can be shared with other users

Messages in the chat are written in markdown, and HTML written inside a message
is shown as HTML. This is useful for tool results that come back as HTML, for
example a wiki page or a web page fetched by a skill.

## Skills

### Compaction

Every model has a limit on how much conversation it can hold at once, its
context window. A long chat, or an agent that has called a lot of tools, will
eventually pass that limit, and from then on every answer fails with an error
about the context length. The Compaction skill shortens the conversation before
that happens, so the agent can carry on working instead of stopping.

Add it to any agent that runs long: agents with tools that return a lot of data
are the ones that need it, because tool results are usually far larger than
anything the user or the agent writes.

**How the conversation is shortened**

There are two ways, and by default the skill uses both, cheapest first:

1. *Clearing old tool results.* The agent's older tool calls are kept, but the
   data they returned is replaced by a note saying it was cleared. This is
   usually enough on its own, it costs nothing, and the agent can always run the
   tool again if it needs the data back.
2. *Summarizing older messages.* If clearing was not enough, the earlier part of
   the conversation is replaced by a written summary of it: what the objective
   is, what has been done, what was decided, what is left, and every identifier
   that came up. This costs one extra call to the model. The first message and
   the most recent messages are always kept word for word, and there is only
   ever one summary - the next compaction rewrites it rather than adding
   another.

**When it happens**

- Before a question is sent to the model, whenever the conversation is estimated
  to be larger than *Compact above*.
- If the model rejects a request as too large anyway, the conversation is
  shortened as much as it can be and the question is tried once more.
- When the user types `/compact`, if that is allowed. Anything written after the
  command tells the summary what to pay attention to, for example
  `/compact keep every invoice number`.

**The chat is not affected**

Compaction only changes what the *model* is given. What the user sees in the
chat is untouched: the whole conversation is still there, still scrolls back to
the beginning, and nothing disappears from the screen. A small note appears
where the conversation was shortened, which can be turned off. Note that
searching your previous chats searches what the model still holds, so text that
has been summarized away will no longer be found by a search.

**Settings**

| Setting | Meaning |
|---|---|
| Compact above | The size, in tokens, at which the conversation gets shortened. Set it below the context window of the model you are using - 100,000 is a safe start for a 200,000 token model. A token is roughly four characters. |
| How to shorten | Whether to clear old tool results, summarize older messages, or both. Both is recommended. |
| Keep recent tool results | How much of the newest tool output is never cleared. The results of whatever the agent is working on right now are always kept, whatever this is set to. |
| Minimum worth clearing | Nothing is cleared unless doing so frees at least this much, so the agent does not lose data for a negligible gain. |
| Keep recent messages | How much of the most recent conversation is kept word for word and never replaced by the summary. |
| Summary instructions | Optional. What the summary must always pay attention to for this agent, for example which identifiers must never be lost. |
| Summarize with | Optional. Write the summary using a different, usually cheaper, LLM configuration. |
| Summary model | Optional. Use a different model for the summary only. |
| Tool result size in summary | How much of each tool result is shown to the summarizer before it is cut short. |
| Total size in summary | The limit on the whole conversation handed to the summarizer. That request has to fit in the context window as well. |
| Allow /compact | Whether the user may shorten the conversation on demand by typing `/compact`. |
| Show a notice | Whether to tell the user in the chat that the conversation was shortened. |
| Keep a record | Whether to store what was summarized away, for looking at afterwards. It is not shown to the user or to the agent. |

If the agent starts forgetting things it should not, the setting to change first
is *Summary instructions*: tell it what matters for this particular agent.