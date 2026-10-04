// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { svgSafetyCheck } from "./svg_check.ts";

const wrap = (inner: string, attrs = ""): string => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"${attrs}>${inner}</svg>`;

describe("svgSafetyCheck", () => {
  test("passes clean SVG with local references, image data URLs, and CSS animation", () => {
    const clean = [
      wrap("<rect x=\"0\" y=\"0\" width=\"5\" height=\"5\" fill=\"#ff0000\"/>"),
      `<?xml version="1.0" encoding="UTF-8"?>\n${wrap("<path d=\"M0 0 L5 5 Z\" fill=\"none\" stroke=\"#000000\"/>")}`,
      wrap("<defs><linearGradient id=\"g\"><stop offset=\"0\" stop-color=\"#fff\"/></linearGradient></defs><rect width=\"1\" height=\"1\" fill=\"url(#g)\"/>"),
      wrap("<image width=\"1\" height=\"1\" href=\"data:image/png;base64,iVBORw0KGgo=\"/>"),
      wrap("<use href=\"#a\"/><g id=\"a\"><circle r=\"1\"/></g>", " xmlns:xlink=\"http://www.w3.org/1999/xlink\""),
      wrap("<style>@keyframes k0{0%{transform:translate(1px,2px);opacity:1}}.a0{animation:k0 1s linear infinite both}</style><g class=\"a0\"/>"),
      wrap("<text x=\"1\" y=\"2\">Tom &amp; Jerry &lt;3 caf&#233;</text>"),
      wrap("<!-- a comment --><g/>"),
      `\uFEFF  ${wrap("<g/>")}`,
    ];
    for (const svg of clean) {
      const r = svgSafetyCheck(svg);
      if (!r.ok) throw new Error(`expected pass, got "${r.reason}" for ${svg}`);
    }
  });

  test("refusal table", () => {
    const hostile: [string, string][] = [
      ["script element", wrap("<script>alert(1)</script>")],
      ["namespaced script", wrap("<svg:script>alert(1)</svg:script>", " xmlns:svg=\"http://www.w3.org/2000/svg\"")],
      ["uppercase script", wrap("<SCRIPT>alert(1)</SCRIPT>")],
      ["foreignObject", wrap("<foreignObject><div/></foreignObject>")],
      ["iframe", wrap("<iframe/>")],
      ["onload", wrap("<g/>", " onload=\"alert(1)\"")],
      ["onclick uppercase", wrap("<rect ONCLICK=\"x()\"/>")],
      ["namespaced on attr", wrap("<rect ev:onclick=\"x()\"/>")],
      ["javascript href", wrap("<a href=\"javascript:alert(1)\"><text>x</text></a>")],
      ["javascript split by tab", wrap("<a href=\"java\tscript:alert(1)\"><text>x</text></a>")],
      ["javascript split by newline entity", wrap("<a href=\"java&#10;script:alert(1)\"><text>x</text></a>")],
      ["numeric ref to letter", wrap("<a href=\"&#106;avascript:alert(1)\"><text>x</text></a>")],
      ["hex ref to letter", wrap("<a href=\"&#x6A;avascript:alert(1)\"/>")],
      ["data text/html", wrap("<a href=\"data:text/html,<script>alert(1)</script>\"/>")],
      ["data svg image", wrap("<image href=\"data:image/svg+xml;base64,PHN2Zz4=\"/>")],
      ["external http image", wrap("<image href=\"http://evil.example/x.png\"/>")],
      ["external https use", wrap("<use href=\"https://evil.example/s.svg#a\"/>")],
      ["protocol-relative", wrap("<image href=\"//evil.example/x.png\"/>")],
      ["file href", wrap("<image xlink:href=\"file:///etc/passwd\"/>", " xmlns:xlink=\"http://www.w3.org/1999/xlink\"")],
      ["doctype", `<!DOCTYPE svg [<!ENTITY x "y">]>${wrap("<g/>")}`],
      ["entity decl", `<!ENTITY x SYSTEM "file:///etc/passwd">${wrap("<g/>")}`],
      ["cdata", wrap("<style><![CDATA[g{fill:red}]]></style>")],
      ["xml-stylesheet PI", `<?xml-stylesheet href="http://evil.example/x.css"?>${wrap("<g/>")}`],
      ["PI after content", `${wrap("<g/>")}<?xml version="1.0"?>`],
      ["@import", wrap("<style>@import 'http://evil.example/x.css';</style>")],
      ["css url external", wrap("<rect style=\"fill:url(http://evil.example/x)\"/>")],
      ["css url with space", wrap("<rect style=\"fill:url (http://evil.example/x)\"/>")],
      ["css escape", wrap("<style>g{fill:\\75 rl(x)}</style>")],
      ["css expression", wrap("<rect style=\"width:expression(alert(1))\"/>")],
      ["smil href", wrap("<a><set attributeName=\"href\" to=\"#x\"/></a>")],
      ["xlink smil href", wrap("<a><animate attributeName=\"xlink:href\" values=\"#x\"/></a>")],
      ["foreign namespace", wrap("<g/>", " xmlns:h=\"http://www.w3.org/1999/xhtml\"")],
      ["xml:base", wrap("<g xml:base=\"http://evil.example/\"/>")],
      ["unquoted attr", wrap("<rect width=5/>")],
      ["valueless attr", wrap("<rect hidden/>")],
      ["unknown entity", wrap("<text>&nbsp;</text>")],
      ["bare ampersand", wrap("<text>a & b</text>")],
      ["unterminated comment", `${wrap("<g/>")}<!-- open`],
      ["NUL", wrap("<g/>\u0000")],
      ["not markup", "hello <svg/>"],
      ["no svg", "<html/>"],
      ["oversize", wrap(`<g>${" ".repeat(20 * 1024 * 1024)}</g>`)],
    ];
    for (const [name, svg] of hostile) {
      const r = svgSafetyCheck(svg);
      if (r.ok) throw new Error(`expected refusal: ${name}`);
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  test("never throws on junk", () => {
    for (const junk of ["", "<", "<svg", "<svg a=\"", "<svg><", "&", "&#", "&#x;", "<svg><style>", "\uD800"]) {
      expect(svgSafetyCheck(junk).ok).toBe(false);
    }
    expect(svgSafetyCheck(undefined as unknown as string).ok).toBe(false);
  });
});
