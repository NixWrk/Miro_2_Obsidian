import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../src/i18n";
import { codeLineCount, fitFontSize, lineNumbersCss, plainText } from "../src/text-fit";
import { frameColors, miroStickyColors, readableInk, stickyFill } from "../src/miro-palette";

describe("plain text of stored markup", () => {
  it("keeps the words and drops tags, entities and markdown marks", () => {
    expect(plainText("<div style=\"font-size:18px\"><p>REST sticky <strong>yellow</strong></p></div>")).toBe("REST sticky yellow");
    expect(plainText("<p>one</p><p>two &amp; three&#33;</p>")).toBe("one\ntwo & three!");
    expect(plainText("## **Heading** with `code`")).toBe("Heading with code");
    expect(plainText(undefined)).toBe("");
  });
});

describe("code line numbers", () => {
  it("counts the lines of the code a node shows", () => {
    expect(codeLineCount("<p>Title</p><pre style=\"x\"><code>a\nb\nc</code></pre>")).toBe(3);
    expect(codeLineCount("<pre><code>one<br>two</code></pre>")).toBe(2);
    expect(codeLineCount("Intro\n```js\nconst a = 1;\nconst b = 2;\n```")).toBe(2);
    expect(codeLineCount("just one line")).toBe(1);
    expect(codeLineCount("<pre><code>\nfirst\nsecond\n</code></pre>")).toBe(2);
    expect(codeLineCount(undefined)).toBe(1);
    expect(codeLineCount(`<pre>${"x\n".repeat(9000)}</pre>`)).toBe(5000);
  });

  it("writes them as one CSS string, a line each", () => {
    expect(lineNumbersCss(3)).toBe("\"1\\A 2\\A 3\"");
    expect(lineNumbersCss(0)).toBe("\"1\"");
  });
});

describe("fitted font size", () => {
  it("picks the size Miro shows for its sample notes", () => {
    // A wide note fits two lines; a square one with a long word goes smaller.
    const wide = fitFontSize("REST sticky yellow", 280, 160);
    const square = fitFontSize("REST sticky light_yellow", 199, 228);
    expect(wide).toBeGreaterThanOrEqual(30);
    expect(square).toBeLessThan(wide);
  });

  it("never breaks a word to make it fit", () => {
    const size = fitFontSize("incomprehensibilities", 200, 400);
    // The word alone has to fit the inner width at the chosen size.
    expect(21 * size * 0.6).toBeLessThanOrEqual(200 * 0.84);
  });

  it("shrinks as the text grows and stays within its bounds", () => {
    const short = fitFontSize("Idea", 200, 200);
    const long = fitFontSize("An idea that needs a much longer explanation to fit here", 200, 200);
    expect(long).toBeLessThan(short);
    expect(short).toBeLessThanOrEqual(64);
    expect(fitFontSize("x ".repeat(5000), 50, 50)).toBe(8);
    expect(fitFontSize("", 200, 100)).toBeLessThanOrEqual(64);
    expect(fitFontSize("text", 0, 100)).toBe(8);
  });
});

describe("Miro sticky colours", () => {
  it("names every REST sticky colour, gray included", () => {
    expect(miroStickyColors().map((entry) => entry.token)).toEqual([
      "light_yellow", "yellow", "orange", "red", "light_pink", "pink", "light_blue", "violet",
      "blue", "dark_blue", "cyan", "dark_green", "light_green", "green", "gray", "black", "white",
    ]);
    expect(stickyFill("gray")).toBe("#f4f6f8");
    expect(stickyFill("Grey")).toBe("#f4f6f8");
    expect(stickyFill("magenta")).toBeUndefined();
  });

  it("inks a dark note white and every other one near-black", () => {
    expect(readableInk(stickyFill("black")!)).toBe("#ffffff");
    for (const entry of miroStickyColors().filter((item) => item.token !== "black")) {
      expect(readableInk(entry.color)).toBe("#1a1a1a");
    }
    expect(readableInk("not a colour")).toBe("#1a1a1a");
  });
});

describe("Miro's palettes in Russian", () => {
  afterEach(() => setLocale("en"));

  it("names sticky and frame fills from the Russian word table", () => {
    setLocale("ru");
    const yellow = miroStickyColors().find((entry) => entry.token === "yellow");
    expect(yellow?.label).toBe("Жёлтый");
    const lightYellow = miroStickyColors().find((entry) => entry.token === "light_yellow");
    expect(lightYellow?.label).toBe("Светло-жёлтый");
    const frameGray = frameColors().find((entry) => entry.token === "frame_gray");
    expect(frameGray?.label).toBe("Серый");
  });
});
