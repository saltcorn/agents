const { div, pre, a } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const User = require("@saltcorn/data/models/user");
const File = require("@saltcorn/data/models/file");
const View = require("@saltcorn/data/models/view");
const Trigger = require("@saltcorn/data/models/trigger");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { interpolate, sleep } = require("@saltcorn/data/utils");
const { features } = require("@saltcorn/data/db/state");
const { button } = require("@saltcorn/markup/tags");
const { validID } = require("@saltcorn/markup/layout_utils");

const vm = require("vm");
const { replaceUserContinue } = require("../common");

function extractCode(str) {
  // Try ```javascript fence
  if (str.includes("```javascript")) {
    return str.split("```javascript")[1].split("```")[0];
  }
  // Try ```js fence
  if (str.includes("```js\n") || str.includes("```js\r")) {
    return str.split(/```js\s/)[1].split("```")[0];
  }
  // Try generic ``` fence (code is between first and second ```)
  const fenceMatch = str.match(/```\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1];
  }
  // No fences found - return raw string
  return str;
}

//const { fieldProperties } = require("./helpers");

class GenerateAndRunJsCodeSkill {
  static skill_name = "Generate and run JavaScript code";

  get skill_label() {
    return "Generate and run JavaScript code";
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  async runCode(code, { user, req }) {
    const sysState = getState();

    const f = vm.runInNewContext(`async () => {${code}\n}`, {
      ...(this.allow_table
        ? {
            Table: Table.subClass
              ? Table.subClass({ user, read_only: this.read_only })
              : Table,
          }
        : {}),
      ...(this.allow_fetch ? { fetch } : {}),
      ...(this.allow_functions ? sysState.eval_context : {}),
      user,
      console,
      sleep,
      setTimeout,
      URL,
      Buffer,
      console,
    });
    return await f();
  }

  async systemPrompt({ triggering_row, user }) {
    return this.add_sys_prompt || "";
  }

  async skillRoute({ run, triggering_row, req }) {
    return await this.runCode({ row: triggering_row, run, user: req.user });
  }

  static async configFields() {
    return [
      {
        name: "tool_name",
        label: "Tool name",
        type: "String",
        class: "validate-identifier",
      },
      {
        name: "tool_description",
        label: "Tool description",
        type: "String",
      },

      {
        name: "code_description",
        label: "Code description",
        type: "String",
        fieldview: "textarea",
      },
      {
        name: "add_sys_prompt",
        label: "Additional system prompt",
        type: "String",
        fieldview: "textarea",
      },
      {
        name: "allow_fetch",
        label: "Allow HTTP fetch",
        type: "Bool",
      },
      {
        name: "allow_table",
        label: "Allow access to tables",
        type: "Bool",
      },
      {
        name: "allow_functions",
        label: "Allow system functions",
        sublabel: "Allow calls to functions from codepages and modules",
        type: "Bool",
      },
      {
        name: "follow_up_prompt",
        label: "Follow-up prompt",
        sublabel:
          "If set, the agent will continue processing after code execution with this prompt. Leave empty to stop after code result.",
        type: "String",
        fieldview: "textarea",
      },
      ...(Table.subClass
        ? [
            {
              name: "table_read_only",
              label: "Read only?",
              type: "Bool",
              showIf: { allow_table: true },
            },
          ]
        : []),
    ];
  }

  provideTools = () => {
    return {
      type: "function",
      process: async (row, { req }) => {
        return "Code generation tool activated";
        //return await this.runCode({ row, user: req.user });
      },
      /*renderToolCall({ phrase }, { req }) {
        return div({ class: "border border-primary p-2 m-2" }, phrase);
      },*/
      postProcess: async ({
        tool_call,
        req,
        generate,
        emit_update,
        chat,
        ...rest
      }) => {
        //console.log("postprocess args", { tool_call, ...rest });
        emit_update("Generating code");
        const gen_the_code = async (extra) => {
          const str = await generate(
            `You will now be asked to write JavaScript code.          
${this.code_description ? "\nSome more information: " + this.code_description : ""}
${this.allow_fetch ? "\nYou can use the standard fetch JavaScript function to make HTTP(S) requests." : ""}
${this.allow_table ? getTablePrompt(this.read_only) : ""}

The code you write can use await at the top level, and should return 
(at the top level) either a string (which can contain HTML tags) with the response which will be shown 
to the user, or a JSON object which will then be further summarized for the user.

Example:

\`\`\`javascript

const x = await myAsyncFunction()
const y = await anotherAsyncFunction(x)

return \`The eggs are \${x} and the why is \${y}\`
\`\`\`

or

\`\`\`javascript

const x = await myAsyncFunction()
const y = await anotherAsyncFunction(x)

return { x, y }
\`\`\`

${extra || ""}

CRITICAL: Your response must contain ONLY a single JavaScript code block wrapped in \`\`\`javascript ... \`\`\` fences. Do not include any text, explanation, or commentary before or after the code block.

Now generate the JavaScript code required by the user.`,
          );
          getState().log(
            6,
            "Generated code:\n--BEGIN CODE--\n" + str + "\n--END CODE--\n",
          );
          const js_code = extractCode(str);
          return js_code;
        };
        const js_code = await gen_the_code();
        emit_update("Running code");
        const ensureResult = (res) => {
          if (res && typeof res === "object") return JSON.stringify(res);
          if (res !== undefined && res !== null && res !== "") return res;
          return "Code executed successfully but returned no output.";
        };
        const mkMdResponse = (result, code) =>
          req?.user?.role_id === 1
            ? `<details>

<summary>Show code</summary>

\`\`\`javascript
${code}
\`\`\`

⇒
</details>

${result}`
            : result;
        try {
          const res = await this.runCode(js_code, { user: req.user });
          getState().log(6, "Code answer: " + JSON.stringify(res));
          const effectiveRes = ensureResult(res);
          return {
            stop: typeof res === "string" && !this.follow_up_prompt,
            add_response: {
              role: "user",
              content: `The result of running the code is: ${effectiveRes}`,
              md_response: mkMdResponse(effectiveRes, js_code),
            },
            ...(this.follow_up_prompt
              ? { follow_up_prompt: this.follow_up_prompt }
              : {}),
          };
        } catch (err) {
          console.error(err);
          const retry_js_code =
            await gen_the_code(`You were previously asked to complete this task. This was the code generated:
\`\`\`javascript
${js_code}
\`\`\`

this code produced the following error:

\`\`\`
${err.message}
\`\`\`

Correct this error and generate the new Javascript code to run
`);
          try {
            const res = await this.runCode(retry_js_code, {
              user: req.user,
            });
            getState().log(6, "Code retry answer: " + JSON.stringify(res));
            const effectiveRes = ensureResult(res);
            return {
              stop: typeof res === "string" && !this.follow_up_prompt,
              add_response: {
                role: "user",
                content: `The result of running the code is: ${effectiveRes}`,
                md_response: mkMdResponse(effectiveRes, retry_js_code),
              },
              ...(this.follow_up_prompt
                ? { follow_up_prompt: this.follow_up_prompt }
                : {}),
            };
          } catch (retryErr) {
            console.error(retryErr);
            return {
              add_response:
                "Error: code generation failed after retry: " +
                retryErr.message,
            };
          }
        }
      },
      function: {
        name: this.tool_name,
        description: this.tool_description,
        parameters: {
          type: "object",
          properties: {},
        },
      },
    };
  };
}

const getTablePrompt = (read_only) => {
  const state = getState();
  const tables = state.tables;
  const tableLines = [];
  tables.map(t=>new Table(t)).forEach((table) => {
    const fieldLines = table.fields.map(
      (f) =>
        `  * ${f.name} with type: ${
          f?.pretty_type
            ? f.pretty_type.replace("Key to", "ForeignKey referencing")
            : "Unknown"
        }.${f?.description ? ` ${f.description}` : ""}`,
    );
    tableLines.push(
      `${table.name}${
        table.description ? `: ${table.description}.` : "."
      } Contains the following fields:\n${fieldLines.join("\n")}`,
    );
  });
  return `Use the Table variable to access the Table class which gives you access to database tables

Example:

const someTable = Table.findOne({name: "Orders"})
await someTable.insertRow({name: "Alex", age: 43})
await someTable.deleteRows({id: order})


You can use the Table class to access database tables. Use this to create or delete tables and 
their properties, or to query or change table rows.

To query, update, insert or delete rows in an existing table, first you should find the 
table object with findOne.

Example: 

Table.findOne({name: "Customers"}) // find the table with name "Customers"
Table.findOne("Customers") // find the table with name "Customers" (shortcut)
Table.findOne({ id: 5 }) // find the table with id=5
Table.findOne(5) // find the table with id=5 (shortcut)

Table.findOne is synchronous (no need to await), But the functions that query and manipulate 
(such as insertRow, getRows, updateRow, deleteRows) rows are mostly asyncronous, so you can 
put the await in front of the whole expression.

Example:
To count the number of rows in the customer table:

const nrows = await Table.findOne("Customers").countRows({})

Querying table rows

There are several methods you can use to retrieve rows in the database:

countRows: Count the number of rows in db table. The argument is a where-expression with conditions the
counted rows should match. countRows returns the number of matching rows wrapped in a promise.

countRows(where?): Promise<number>
Count amount of rows in db table

Parameters
Optional where: Where
Returns Promise<number>

Example of using countRows: 
const bookTable = Table.findOne({name: "books"})
 
// Count the total number of rows in the books table
const totalNumberOfBooks = await bookTable.countRows({})

// Count the number of books where the cover_color field has the value is "Red"
const numberOfRedBooks = await bookTable.countRows({cover_color: "Red"})

// Count number of books with more than 500 pages
const numberOfLongBooks = await bookTable.countRows({pages: {gt: 500}})

getRows: Get all matching rows from the table in the database.

The arguments are the same as for getRow. The first argument is where-expression
with the conditions to match, and the second argument is an optional object and 
allows you to set ordering and limit options. Keywords that can be used in the 
second argument are orderBy, orderDesc, limit and offset.

getRows will return an array of rows matching the where-expression in the first 
argument, wrapped in a Promise (use await to read the array).


getRows(where?, selopts?): Promise<Row[]>
Get rows from Table in db

Parameters
where: Where = {}
selopts: SelectOptions & ForUserRequest = {}
Returns Promise<Row[]>

Example of using getRows:

const bookTable = Table.findOne({name: "books"})

// get the rows in the book table with author = "Henrik Pontoppidan"
const myBooks = await bookTable.getRows({author: "Henrik Pontoppidan"})

// get the 3 most recent books written by "Henrik Pontoppidan" with more that 500 pages
const myBooks = await bookTable.getRows({author: "Henrik Pontoppidan", pages: {gt: 500}}, {orderBy: "published", orderDesc: true})

getRow: Get one row from the table in the database. The matching row will be returned in a promise - 
use await to read the value. If no matching rule can be found, null will be returned. If more than one
 row matches, the first found row will be returned.

The first argument to get row is a where-expression With the conditions the returned row should match.

The second document is optional and is an object that can modify the search. This is mainly useful in 
case there is more than one matching row for the where-expression in the first argument and you want to 
give an explicit order. For example, use {orderBy: "name"} as the second argument to pick the first 
row by the name field, ordered ascending. {orderBy: "name", orderDesc: true} to order by name, descending

This is however rare and usually getRow is run with a single argument of a Where expression that uniquely 
determines the row to return, if it exisits.

getRow(where?, selopts?): Promise<null | Row>
Get one row from table in db

Parameters
where: Where = {}
selopts: SelectOptions & ForUserRequest = {}
Returns Promise<null | Row>

Example of using getRow:
const bookTable = Table.findOne({name: "books"})

// get the row in the book table with id = 5
const myBook = await bookTable.getRow({id: 5})

// get the row for the last book published by Leo Tolstoy
const myBook = await bookTable.getRow({author: "Leo Tolstoy"}, {orderBy: "published", orderDesc: true})

getJoinedRows: To retrieve rows together with joinfields and aggregations

getJoinedRows(opts?): Promise<Row[]>
Get rows along with joined and aggregated fields. The argument to getJoinedRows is an object with several different possible fields, all of which are optional

where: A Where expression indicating the criterion to match
joinFields: An object with the joinfields to retrieve
aggregations: An object with the aggregations to retrieve
orderBy: A string with the name of the field to order by
orderDesc: If true, descending order
limit: A number with the maximum number of rows to retrieve
offset: The number of rows to skip in the result before returning rows
Parameters
Optional opts: any = {}
Returns Promise<Row[]>

Example of using getJoinedRows: 

const patients = Table.findOne({ name: "patients" });
const patients_rows = await patients.getJoinedRows({
     where: { age: { gt: 65 } },
     orderBy: "id",
     aggregations: {
       avg_temp: {
         table: "readings",
         ref: "patient_id",
         field: "temperature",
         aggregate: "avg",
      },
     },
     joinFields: {
       pages: { ref: "favbook", target: "pages" },
       author: { ref: "favbook", target: "author" },
     },
});

These functions all take "Where expressions" which are JavaScript objects describing 
the criterion to match to. Some examples:

{ name: "Jim" }: Match all rows with name="Jim"
{ name: { ilike: "im"} }: Match all rows where name contains "im" (case insensitive)
{ name: /im/ }: Match all rows with name matching regular expression "im"
{ age: { lt: 18 } }: Match all rows with age<18
{ age: { lt: 18, equal: true } }: Match all rows with age<=18
{ age: { gt: 18, lt: 65} }: Match all rows with 18<age<65
{ name: { or: ["Harry", "Sally"] } }: Match all rows with name="Harry" or "Sally"
{ or: [{ name: "Joe"}, { age: 37 }] }: Match all rows with name="Joe" or age=37
{ not: { id: 5 } }: All rows except id=5
{ id: { in: [1, 2, 3] } }: Rows with id 1, 2, or 3

There are two nearly identical functions for updating rows depending on how you want failures treated

${
  !read_only
    ? `updateRow Update a row in the database table, throws an exception if update is invalid

updateRow(v_in, id, user?): Promise<string | void>
Update row

Parameters
v_in: any. columns with values to update

id: number. id value, table primary key

Optional user: Row

Example of using updateRow: 

const bookTable = Table.findOne({name: "books"})

// get the row in the book table for Moby Dick
const moby_dick = await bookTable.getRow({title: "Moby Dick"})

// Update the read field to true and the rating field to 5 in the retrieved row.
await bookTable.updateRow({read: true, rating: 5}, moby_dick.id)

// if you want to update more than one row, you must first retrieve all the rows and 
// then update them individually

const allBooks = await bookTable.getRows()
for(const book of allBooks) {
  await bookTable.updateRow({price: book.price*0.8}, book.id)
}

tryUpdateRow Update a row, return an error message if update is invalid

There are two nearly identical functions for inserting a new row depending on how you want failures treated

insertRow insert a row, throws an exception if it is invalid
insertRow(v_in, user): Promise<any>
Insert row into the table. By passing in the user as the second argument, tt will check write rights. If a user object is not supplied, the insert goes ahead without checking write permissions.

Returns the primary key value of the inserted row.

This will throw an exception if the row does not conform to the table constraints. If you would like to insert a row with a function that can return an error message, use tryInsertRow instead.

Parameters
v_in: Row
Optional user: Row
Returns Promise<any>

Example of using insertRow: 
await Table.findOne("People").insertRow({ name: "Jim", age: 35 })

tryInsertRow insert a row, return an error message if it is invalid

Use deleteRows to delete any number (zero, one or many) of rows matching a criterion. It uses the same where expression as the functions for querying rows
deleteRows(where, user?, noTrigger?): Promise<void>
Delete rows from table

Parameters
where: Where
condition

Optional user: Row
optional user, if null then no authorization will be checked

Optional noTrigger: boolean
Returns Promise<void>`
    : ""
}

The following tables are present in the database:

${tableLines.join("\n\n")}`;
};

module.exports = GenerateAndRunJsCodeSkill;
