import { describe, expect, it } from "vitest";

import { hasHighlight, highlightText, isHtmlText, markSelection, unhighlightText } from "../src/text-highlight";

describe("highlighting a card's text", () => {
  it("marks every line of Markdown, leaving what leads a line outside the mark", () => {
    expect(highlightText("Plain text")).toBe("==Plain text==");
    expect(highlightText("# Title\n\n- first\n- [ ] task\n> quote\n1. step")).toBe(
      "# ==Title==\n\n- ==first==\n- [ ] ==task==\n> ==quote==\n1. ==step==",
    );
  });

  it("leaves code, rules and a table's divider alone and marks each table cell", () => {
    expect(highlightText("```\ncode\n```\n---")).toBe("```\ncode\n```\n---");
    expect(highlightText("| a | b |\n| --- | --- |\n| 1 |  |")).toBe("| ==a== | ==b== |\n| --- | --- |\n| ==1== |  |");
  });

  it("marks inside an HTML block, where Markdown marks would show as text", () => {
    const card = '<div style="font-size:18px; line-height:1.35"><p><strong>Карточка</strong></p></div>';
    expect(isHtmlText(card)).toBe(true);
    expect(highlightText(card)).toBe('<div style="font-size:18px; line-height:1.35"><p><mark><strong>Карточка</strong></mark></p></div>');
    expect(highlightText('<div style="font-size:28px">Deadline</div>')).toBe('<div style="font-size:28px"><mark>Deadline</mark></div>');
  });

  it("takes every mark off again, and marking twice marks once", () => {
    for (const text of ["# Title\n- item", '<div><p>One</p><p>Two</p></div>', "| a | b |\n| --- | --- |"]) {
      const marked = highlightText(text);
      expect(hasHighlight(marked)).toBe(true);
      expect(highlightText(marked)).toBe(marked);
      expect(unhighlightText(marked)).toBe(text);
    }
    expect(unhighlightText("```\na ==b== c\n```")).toBe("```\na ==b== c\n```");
    expect(hasHighlight("no marks")).toBe(false);
  });

  it("marks a selection line by line in Markdown and whole in HTML", () => {
    expect(markSelection("one\ntwo", false)).toBe("==one==\n==two==");
    expect(markSelection("<b>x</b>", true)).toBe("<mark><b>x</b></mark>");
    expect(markSelection("  ", false)).toBe("  ");
  });
});
