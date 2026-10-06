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
* Ask user question - lets the agent put one or more questions to the user (pick one, tick several, or write an answer) and wait for the answers before it carries on


The agents can be run either by attaching them to events (table inserts, inbound API calls etc; in chich case an initial prompt, based on the variables in the triggering row has to be specified) or by building a view based on the Agent chat viewpatterns which is configured by picking an agent action, giving the user an interactive chat interface similar to the chatgpt interface. Previous chats can be accessed on the left in this interface, and chats can be shared with other users

Messages in the chat are written in markdown, and HTML written inside a message
is shown as HTML. This is useful for tool results that come back as HTML, for
example a wiki page or a web page fetched by a skill.

## Skills

### Ask user question

An agent working on a task often reaches a point where it has to know something
only the user can decide: which of two tables to write to, whether to include
last year's figures, which of three customers with the same name was meant. An
agent without this skill has to guess, or write the question into its reply and
hope the user notices and answers it.

With this skill the agent can instead put the question to the user as a set of
answers to choose from. **The agent stops there.** Nothing else happens, no
further tools are run and no reply is written, until the user chooses. What they
chose is then sent back to the agent as if they had typed it, and the agent
carries on from there.

Short answers appear as a row of buttons, one press and the answer is given.
Longer answers do not fit on buttons, so the question is presented as a list of
radio buttons with an *Answer* button underneath instead. That switch is
automatic and needs no setting: the list is used as soon as any one answer is
longer than 15 characters, or all the answers together come to more than 40.

**Kinds of question**

The agent chooses the kind of each question it asks:

* *Pick one* - the user chooses exactly one of the answers offered. This is the
  kind described above, shown as buttons or as a list of radio buttons.
* *Tick any* - the user ticks as many of the answers offered as apply, or none
  at all, using checkboxes, then presses *Answer*.
* *Written answer* - there are no answers to choose from; the user writes their
  answer in a text box and presses *Answer*.

**Several questions at once**

When the agent needs several related answers before it can go on, it can ask
all the questions together rather than one after the other. Each question then
gets its own tab, labelled with a short name the agent gives it (such as
"Database" or "Notes"); the full question is shown inside the tab. The user can
move between the tabs in any order and presses *Answer* once, when they are
done. If a pick-one question has been left unanswered, pressing *Answer* opens
its tab instead of sending. All the answers are sent to the agent together.

The agent decides when to ask, what kind of question to ask and what the options are; it cannot be forced to
ask, but it can be told when it should, in the *Additional system prompt*
setting - for example "always ask which department a new record belongs to,
never guess".

**Discussing instead of answering**

Sometimes the offered answers are not right, or the user needs to know more
before they can pick one. The agent can add an extra choice, labelled *Discuss
instead* by default, which tells it to stop and talk the question through rather
than treat any answer as chosen. Whether that choice appears is up to the agent,
which is asked to offer it when the answers may not cover every case.

The user is never forced to choose in any case: they can always simply type into
the chat as normal, and the agent takes that as the answer. The buttons are a
shortcut, not a lock. Once the question has been answered it disappears from the
chat, so the same question cannot be answered twice.

**Settings**

| Setting | Meaning |
|---|---|
| Additional system prompt | Optional. When this agent should ask a question, in your own words. The standard explanation of how the tool works is always included, so this only needs to say what is particular to your agent. |
| Prompt on answer | Optional. The message the agent receives for each question the user answers. Write `{{ question }}`, `{{ answer }}` and `{{ answer_description }}` where those should appear. When several options are ticked, `{{ answer }}` lists them all. |
| Discuss button label | Optional. The wording on the extra choice that declines to answer, if the agent offers one. |
| Prompt on discuss | Optional. The message the agent receives when that button is pressed. Write `{{ question }}` where the question should appear; with several questions, they are all included. |

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
### Web search

Gives the agent a tool to search the internet and read back the results. Three
providers are offered:

- **Tavily** and **Firecrawl**, two search services built for AI agents. Both
  need an account and an API key, and both return results already tidied up for
  the agent to read.
- **By URL template**, for any other search engine that answers over a plain
  URL. Write the address of the search page with `{{q}}` where the search
  phrase belongs, for example
  `https://api.search.brave.com/res/v1/web/search?q={{q}}`. If the engine needs
  an API key in a header, put it in *Header*. Whatever the page returns is
  handed to the agent as it stands.

**Choosing which sites the agent may use**

An agent gathering evidence usually should not be searching the whole web. It
should be looking at the statistics office, the professional body, the
regulator - and not at comparison sites, forums or advertising pages.

*Restrict to domains* and *Exclude domains* do this. Write hostnames separated
by commas, for example `ons.gov.uk, nice.org.uk`. Anything in *Restrict to
domains* becomes the only place the agent can find results; anything in *Exclude
domains* is kept out of them.

This is worth doing even if the agent has already been told in its prompt which
sources to prefer. A prompt is a request the agent may quietly ignore on a
search that finds nothing; these settings are applied to the search itself, so
there is no result from an unwanted site for the agent to cite. Leave both empty
and the agent searches the whole web as before.

Both fields apply to Tavily and Firecrawl. Tavily filters on the domains
directly. Firecrawl has no such setting, so the restriction is added to the
search phrase as `site:` terms, which its search engine understands; the effect
is the same but it depends on the engine honouring them, so Tavily is the surer
choice if strict source control matters.

**Settings**

| Setting | Meaning |
|---|---|
| Search provider | Tavily, Firecrawl, or any other engine by URL template. |
| URL template | For *By URL template* only. The search address, with `{{q}}` where the search phrase goes. |
| Header | For *By URL template* only. One header sent with the request, written as `Name: value`, for example `X-Subscription-Token: YOUR_API_KEY`. |
| API key | For Tavily and Firecrawl. |
| Restrict to domains | Optional. Comma-separated hostnames the agent may use. Empty means no restriction. |
| Exclude domains | Optional. Comma-separated hostnames the agent may not use. |
