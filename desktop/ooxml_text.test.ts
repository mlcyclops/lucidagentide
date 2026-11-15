// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ooxml_text.test.ts - P-ATTACH.1 (ADR-0598): Word / Excel / PowerPoint text, built from tiny OOXML
// packages made in the test, and the ZIP bomb and malformed-input guards (every failure throws).

import { describe, expect, test } from "bun:test";
import { zipEntries } from "../harness/kb/zip.ts";
import { columnIndex, decodeXmlEntities, extractOoxmlText, OOXML_LIMITS, resolvePartPath } from "./ooxml_text.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const pkg = (files: Record<string, string | Uint8Array>) =>
  new Uint8Array(zipEntries(Object.entries(files).map(([name, v]) => ({ name, data: typeof v === "string" ? enc(v) : v }))));

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;

describe("docx", () => {
  test("paragraphs, runs, tabs, breaks and entities; tab stops are not characters", () => {
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world &amp; co</w:t></w:r></w:p>
<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C &#x263A;</w:t></w:r></w:p>
<!-- a comment with <w:t>hidden</w:t> -->
<w:p><w:r><w:delText>deleted</w:delText><w:t>kept</w:t></w:r></w:p>
</w:body></w:document>`;
    const r = extractOoxmlText("docx", pkg({ "[Content_Types].xml": "<Types/>", "word/document.xml": doc }));
    expect(r.text).toBe("Hello world & co\nA\tB\nC \u263A\nkept");
  });

  test("a package without word/document.xml throws", () => {
    expect(() => extractOoxmlText("docx", pkg({ "word/other.xml": "<x/>" }))).toThrow(/word\/document\.xml/);
  });

  test("broken XML and unknown entities throw", () => {
    expect(() => extractOoxmlText("docx", pkg({ "word/document.xml": `<w:document ${W}><w:p><w:t>open` + "<w:t" }))).toThrow(/unterminated/);
    expect(() => extractOoxmlText("docx", pkg({ "word/document.xml": `<w:document ${W}><w:p><w:r><w:t>&nbsp;</w:t></w:r></w:p></w:document>` }))).toThrow(/unknown XML entity/);
  });

  test("a DOCTYPE (entity definitions) is refused; a > inside an attribute value is not the end of the tag", () => {
    const bomb = `<!DOCTYPE lol [<!ENTITY a "aaaa">]><w:document ${W}><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:document>`;
    expect(() => extractOoxmlText("docx", pkg({ "word/document.xml": bomb }))).toThrow(/DOCTYPE/);
    const quoted = `<w:document ${W}><w:p w:note="a > b"><w:r><w:t>kept</w:t></w:r></w:p></w:document>`;
    expect(extractOoxmlText("docx", pkg({ "word/document.xml": quoted })).text).toBe("kept");
  });

  test("not a ZIP throws", () => {
    expect(() => extractOoxmlText("docx", enc("this is plain text, not a package"))).toThrow(/not a ZIP/);
  });
});

describe("xlsx", () => {
  const workbook = `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
<sheet name="Summary" sheetId="2" r:id="rId2"/><sheet name="Data &amp; More" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<Relationships>
<Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="ws" Target="/xl/worksheets/sheet2.xml"/>
<Relationship Id="rId9" Type="link" Target="https://example.invalid/x" TargetMode="External"/></Relationships>`;
  const shared = `<sst><si><t>Name</t></si><si><r><t>Ri</t></r><r><t>ch</t></r><rPh><t>phonetic</t></rPh></si></sst>`;
  const sheet1 = `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>inline</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42.5</v></c><c r="C2" t="b"><v>1</v></c></row>
</sheetData></worksheet>`;
  const sheet2 = `<worksheet><sheetData><row r="1"><c r="B1" t="str"><v>total</v></c></row></sheetData></worksheet>`;

  test("sheets in workbook order, shared and inline strings, numbers, booleans and gaps", () => {
    const r = extractOoxmlText("xlsx", pkg({
      "xl/workbook.xml": workbook, "xl/_rels/workbook.xml.rels": rels, "xl/sharedStrings.xml": shared,
      "xl/worksheets/sheet1.xml": sheet1, "xl/worksheets/sheet2.xml": sheet2,
    }));
    expect(r.parts).toBe(2);
    expect(r.text).toBe("Sheet: Summary\n\ttotal\n\nSheet: Data & More\nName\t\tinline\nRich\t42.5\tTRUE");
  });

  test("without a workbook the sheets are read in numeric order", () => {
    const r = extractOoxmlText("xlsx", pkg({ "xl/worksheets/sheet10.xml": sheet2, "xl/worksheets/sheet2.xml": sheet2.replace("total", "first") }));
    expect(r.text).toBe("Sheet: Sheet 1\n\tfirst\n\nSheet: Sheet 2\n\ttotal");
  });

  test("a cell that names a missing shared string throws", () => {
    const bad = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>7</v></c></row></sheetData></worksheet>`;
    expect(() => extractOoxmlText("xlsx", pkg({ "xl/sharedStrings.xml": shared, "xl/worksheets/sheet1.xml": bad }))).toThrow(/shared string 7/);
  });
});

describe("pptx", () => {
  test("slides in presentation order, one line per paragraph", () => {
    const pres = `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`;
    const rels = `<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>`;
    const slide = (a: string, b: string) => `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${a}</a:t></a:r></a:p><a:p/><a:p><a:r><a:t>${b}</a:t></a:r><a:br/><a:r><a:t>more</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const r = extractOoxmlText("pptx", pkg({
      "ppt/presentation.xml": pres, "ppt/_rels/presentation.xml.rels": rels,
      "ppt/slides/slide1.xml": slide("One", "first body"), "ppt/slides/slide2.xml": slide("Two", "second body"),
    }));
    expect(r.parts).toBe(2);
    expect(r.text).toBe("Slide 1\nTwo\nsecond body\nmore\n\nSlide 2\nOne\nfirst body\nmore");
  });
});

describe("guards", () => {
  test("a ZIP bomb (a part compressed far past the ratio) throws before it is inflated", () => {
    const zeros = new Uint8Array(4 * 1024 * 1024); // deflates about 1000 to 1
    expect(() => extractOoxmlText("docx", pkg({ "word/document.xml": zeros }))).toThrow(/ZIP bomb/);
  });

  test("entry count, per-entry size, total size and character budgets", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 6; i++) many[`x${i}.xml`] = "<x/>";
    expect(() => extractOoxmlText("docx", pkg(many), { ...OOXML_LIMITS, maxEntries: 5 })).toThrow(/more than the 5 allowed/);
    const doc = `<w:document ${W}><w:p><w:r><w:t>${"a".repeat(200)}</w:t></w:r></w:p></w:document>`;
    expect(() => extractOoxmlText("docx", pkg({ "word/document.xml": doc }), { ...OOXML_LIMITS, maxEntryBytes: 100 })).toThrow(/larger than 100 bytes/);
    expect(() => extractOoxmlText("docx", pkg({ "word/document.xml": doc }), { ...OOXML_LIMITS, maxTotalBytes: 100 })).toThrow(/inflates past/);
    expect(() => extractOoxmlText("docx", pkg({ "word/document.xml": doc }), { ...OOXML_LIMITS, maxChars: 50 })).toThrow(/more than 50 characters/);
  });

  test("a part whose declared size lies is refused", () => {
    const zip = Buffer.from(pkg({ "word/document.xml": `<w:document ${W}><w:p><w:r><w:t>${"lie ".repeat(100)}</w:t></w:r></w:p></w:document>` }));
    // Shrink the uncompressed size in the central directory: inflating past it must fail, never truncate quietly.
    const cen = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(zip.readUInt32LE(cen + 24) - 10, cen + 24);
    expect(() => extractOoxmlText("docx", new Uint8Array(zip))).toThrow();
  });

  test("encrypted entries are refused", () => {
    const zip = Buffer.from(pkg({ "word/document.xml": `<w:document ${W}/>` }));
    const cen = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(1, cen + 8);
    expect(() => extractOoxmlText("docx", new Uint8Array(zip))).toThrow(/encrypted/);
  });
});

describe("helpers", () => {
  test("decodeXmlEntities", () => {
    expect(decodeXmlEntities("a &lt;b&gt; &quot;c&quot; &apos;d&apos; &#65;&#x42;")).toBe("a <b> \"c\" 'd' AB");
    expect(() => decodeXmlEntities("fish & chips")).toThrow(/bare &/);
    expect(() => decodeXmlEntities("&#xD800;")).toThrow(/invalid character reference/);
  });

  test("columnIndex", () => {
    expect(columnIndex("A")).toBe(0);
    expect(columnIndex("Z")).toBe(25);
    expect(columnIndex("AA")).toBe(26);
    expect(columnIndex("XFD")).toBe(16383);
    expect(columnIndex("1")).toBeNull();
  });

  test("resolvePartPath stays inside the package", () => {
    expect(resolvePartPath("xl", "worksheets/sheet1.xml")).toBe("xl/worksheets/sheet1.xml");
    expect(resolvePartPath("xl", "/xl/worksheets/sheet2.xml")).toBe("xl/worksheets/sheet2.xml");
    expect(resolvePartPath("ppt/slides", "../media/a.png")).toBe("ppt/media/a.png");
    expect(() => resolvePartPath("xl", "../../etc/passwd")).toThrow(/leaves the package/);
  });
});
