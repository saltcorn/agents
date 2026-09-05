const { describe, it, expect } = require("@saltcorn/db-common/test_expect");

const { renderMd, sanitizeFragment, balanceHtml } = require("../render-md");

describe("renderMd", () => {
  it("closes unclosed structural tags", () => {
    // the incident: a wiki page truncated mid-table pulled the rest of the
    // page into the message
    const out = renderMd(
      `Here is the page:\n\n<table id="bkmrk-x"><tr><td>Host<td>vSRX`,
    );
    const opens = (out.match(/<table/g) || []).length;
    const closes = (out.match(/<\/table>/g) || []).length;
    expect(opens).toBe(1);
    expect(closes).toBe(1);
    expect(out).toContain("</td>");
    expect(out).toContain("</tr>");
  });

  it("removes scripts, styles and event handlers", () => {
    const out = renderMd(
      `<script>alert(1)</script>` +
        `<style>body{display:none}</style>` +
        `<img src=x onerror=alert(1)>` +
        `<div onclick="alert(1)">click</div>`,
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("<style");
    expect(out).not.toContain("display:none");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("onclick");
    expect(out).toContain("click");
  });

  it("removes javascript: and other unsafe urls", () => {
    const out = renderMd(
      `<a href="javascript:alert(1)">a</a>` +
        `[b](javascript:alert(2))` +
        `<a href="https://example.com/ok">c</a>`,
    );
    // markdown-it leaves a javascript: markdown link as plain text, the
    // sanitizer strips the href of the raw html link: neither is clickable
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain('href="https://example.com/ok"');
  });

  it("drops style and id attributes but keeps class", () => {
    const out = renderMd(
      `<div class="keepme" id="dropme" style="position:fixed">x</div>`,
    );
    expect(out).toContain('class="keepme"');
    expect(out).not.toContain("id=");
    expect(out).not.toContain("style=");
  });

  it("keeps legitimate html: tables, images, details, links", () => {
    const out = renderMd(
      `<details><summary>Code</summary>\n\n` +
        "```javascript\nconst x = 1;\n```\n\n</details>\n\n" +
        `<table><thead><tr><th colspan="2">H</th></tr></thead>` +
        `<tbody><tr><td>a</td><td>b</td></tr></tbody></table>\n\n` +
        `![img](/files/serve/1)\n\n` +
        `[link](https://example.com)`,
    );
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>");
    expect(out).toContain('<th colspan="2"');
    expect(out).toContain("<td>a</td>");
    expect(out).toContain('<img src="/files/serve/1"');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("const x = 1;");
  });

  it("keeps markdown rendering intact", () => {
    const out = renderMd("# Title\n\nsome **bold** text\n\n- one\n- two");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<li>one</li>");
  });

  it("does not double-escape code blocks", () => {
    const out = renderMd("```\n<b>not bold</b>\n```");
    expect(out).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(out).not.toContain("&amp;lt;");
  });

  it("handles non-string input without throwing", () => {
    expect(renderMd(null)).toBe("");
    expect(renderMd(undefined)).toBe("");
    expect(() => renderMd({ a: 1 })).not.toThrow();
  });
});

describe("sanitizeFragment", () => {
  it("sanitizes html without markdown rendering", () => {
    const out = sanitizeFragment(
      `<p>hello</p><script>alert(1)</script><table><tr><td>x`,
    );
    expect(out).toContain("<p>hello</p>");
    expect(out).not.toContain("<script");
    expect(out).toContain("</table>");
  });

  it("does not wrap plain text in paragraphs", () => {
    expect(sanitizeFragment("just text")).toBe("just text");
  });
});

describe("balanceHtml", () => {
  it("closes a tag left open by a truncated tool response", () => {
    // the incident: a wiki page cut off inside a <table start tag took the
    // rest of the chat, and the input form, into itself on reload
    const out = balanceHtml(
      `<div class="chat-bubble"><h2>Warum?</h2>\n` +
        `<table id="bkmrk-x" style="width: 866px; word-spacing: 0\n` +
        `<p>[... gekuerzt]</p></div>`,
    );
    expect((out.match(/<table/g) || []).length).toBe(
      (out.match(/<\/table>/g) || []).length,
    );
    expect((out.match(/<div/g) || []).length).toBe(
      (out.match(/<\/div>/g) || []).length,
    );
  });

  it("keeps the handlers and attributes the chat markup relies on", () => {
    const button =
      `<button data-useraction-id="2a79f7" class="btn btn-primary" ` +
      `onclick="view_post('agent', 'execute_user_action', {rndid: &quot;2a79f7&quot;}, cb)">OK</button>`;
    const out = balanceHtml(`<div class="d-flex mb-2">${button}</div>`);
    expect(out).toContain("onclick=");
    expect(out).toContain("view_post(");
    expect(out).toContain('data-useraction-id="2a79f7"');
    expect(out).toContain("&quot;2a79f7&quot;");
  });

  it("keeps script and style, which the sanitizing passes remove", () => {
    // markup saltcorn generated for an embedded view is trusted and can carry
    // both: this pass is containment, not sanitization
    const out = balanceHtml(
      `<div><style>.x{color:red}</style><script>init()</script></div>`,
    );
    expect(out).toContain("<style>");
    expect(out).toContain("<script>");
    expect(out).toContain("init()");
  });

  it("handles content that is not a string", () => {
    expect(balanceHtml(null)).toBe("");
    expect(balanceHtml(undefined)).toBe("");
    expect(() => balanceHtml({ a: 1 })).not.toThrow();
  });
});
