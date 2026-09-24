import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "../src/i18n";
import {
  RELEASES_URL,
  SKILL_INSTALL_URL,
  APP_SETUP_URL_EN,
  APP_SETUP_URL_RU,
  buildImportGuide,
  downloadSystemName,
  importPrompt,
  vaultFolderPath,
  type ImportGuideActions,
  type ImportGuideOptions,
} from "../src/import-guide";

class FakeElement {
  public readonly nodeType = 1;
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  public parentNode: FakeElement | undefined;
  public textContent = "";
  public className = "";
  public value = "";
  public readOnly = false;
  public type = "";

  public constructor(public readonly tagName: string) {}

  public appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  public append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public addEventListener(name: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  public dispatch(name: string, props: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      listener({ type: name, target: this, ...props });
    }
  }
}

class FakeDocument {
  public createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

function steps(root: FakeElement): FakeElement[] {
  return descendants(root)
    .filter((item) => item.attributes.has("data-step"))
    .sort((a, b) => Number(a.getAttribute("data-step")) - Number(b.getAttribute("data-step")));
}

function stepTitle(step: FakeElement): string {
  return descendants(step).find((item) => item.className === "miro-canvas-import-guide__step-title")!.textContent;
}

function buttons(step: FakeElement): FakeElement[] {
  return descendants(step).filter((item) => item.tagName === "button");
}

const DESKTOP: ImportGuideOptions["platform"] = { isPhone: false, isTablet: false, isMacOS: false, isWin: true, isLinux: false };

function build(platform = DESKTOP, vaultPath = "/home/nik/vault"): {
  readonly root: FakeElement;
  readonly opened: string[];
  readonly copied: string[];
} {
  const opened: string[] = [];
  const copied: string[] = [];
  const actions: ImportGuideActions = {
    onOpenLink: (url) => { opened.push(url); },
    onCopy: (text) => { copied.push(text); },
  };
  const root = buildImportGuide(actions, {
    document: new FakeDocument() as unknown as Document,
    platform,
    vaultPath,
  }) as unknown as FakeElement;
  return { root, opened, copied };
}

afterEach(() => setLocale("en"));

describe("import guide", () => {
  it("renders six steps in order, each with the buttons its content needs", () => {
    const { root } = build();
    const list = steps(root);
    expect(list.map((step) => step.getAttribute("data-step"))).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(list.map(stepTitle)).toEqual([
      "Get miro2obsidian",
      "Or let an AI agent do it",
      "Create your own Miro app",
      "Export into this vault",
      "Open the board",
      "Afterwards",
    ]);
    expect(buttons(list[0]!)).toHaveLength(1);
    expect(buttons(list[1]!)).toHaveLength(2);
    expect(buttons(list[2]!)).toHaveLength(1);
    expect(buttons(list[3]!)).toHaveLength(1);
    expect(buttons(list[4]!)).toHaveLength(0);
    expect(buttons(list[5]!)).toHaveLength(0);
  });

  it("names the system on the download button and opens the releases page", () => {
    expect(downloadSystemName(DESKTOP)).toBe("windows");
    expect(downloadSystemName({ ...DESKTOP, isWin: false, isMacOS: true })).toBe("macos");
    expect(downloadSystemName({ ...DESKTOP, isWin: false, isLinux: true })).toBe("linux");
    const { root, opened } = build();
    const download = buttons(steps(root)[0]!)[0]!;
    expect(download.textContent).toBe("Download for Windows");
    download.dispatch("click");
    expect(opened).toEqual([RELEASES_URL]);
  });

  it("offers no download on a phone or tablet, and says the program needs a computer instead", () => {
    expect(downloadSystemName({ ...DESKTOP, isPhone: true })).toBeUndefined();
    expect(downloadSystemName({ ...DESKTOP, isTablet: true })).toBeUndefined();
    const { root } = build({ ...DESKTOP, isPhone: true });
    const step = steps(root)[0]!;
    expect(buttons(step)).toHaveLength(0);
    const text = descendants(step).filter((item) => item.tagName === "p").map((item) => item.textContent);
    expect(text.some((line) => line.includes("computer"))).toBe(true);
  });

  it("puts this vault's path into the AI agent's prompt, and copies exactly that text", () => {
    const { root, copied } = build(DESKTOP, "/Users/nik/My Vault");
    expect(importPrompt("/Users/nik/My Vault")).toContain("/Users/nik/My Vault");
    const step = steps(root)[1]!;
    const textarea = descendants(step).find((item) => item.tagName === "textarea")!;
    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toBe(importPrompt("/Users/nik/My Vault"));
    const [copyPrompt, installLink] = buttons(step);
    copyPrompt!.dispatch("click");
    expect(copied).toEqual([importPrompt("/Users/nik/My Vault")]);
    expect(installLink!.textContent).toBe("How to install the skill");
  });

  it("shows this vault's folder path next to a working copy-path button", () => {
    const { root, copied } = build(DESKTOP, "/Users/nik/My Vault");
    const step = steps(root)[3]!;
    const path = descendants(step).find((item) => item.className === "miro-canvas-import-guide__path")!;
    expect(path.textContent).toBe("/Users/nik/My Vault");
    buttons(step)[0]!.dispatch("click");
    expect(copied).toEqual(["/Users/nik/My Vault"]);
  });

  it("reads a plain filesystem adapter's base path, else falls back to the vault's name", () => {
    expect(vaultFolderPath({ getBasePath: () => "C:/vaults/main" }, "main")).toBe("C:/vaults/main");
    expect(vaultFolderPath({}, "main")).toBe("main");
    expect(vaultFolderPath({ getBasePath: () => { throw new Error("no"); } }, "main")).toBe("main");
    expect(vaultFolderPath(null, "main")).toBe("main");
  });

  it("opens the Miro app setup guide in the language in use", () => {
    const { root, opened } = build();
    buttons(steps(root)[2]!)[0]!.dispatch("click");
    expect(opened).toEqual([APP_SETUP_URL_EN]);
    setLocale("ru");
    const russian = build();
    buttons(steps(russian.root)[2]!)[0]!.dispatch("click");
    expect(russian.opened).toEqual([APP_SETUP_URL_RU]);
  });

  it("opens the skill's install instructions from its own link", () => {
    const { root, opened } = build();
    const step = steps(root)[1]!;
    buttons(step)[1]!.dispatch("click");
    expect(opened).toEqual([SKILL_INSTALL_URL]);
  });
});

describe("import guide in Russian", () => {
  afterEach(() => setLocale("en"));

  it("builds every step's title and button from the Russian word table", () => {
    setLocale("ru");
    const { root } = build();
    const list = steps(root);
    expect(list.map(stepTitle)).toEqual([
      "Установите miro2obsidian",
      "Или доверьте это ИИ-агенту",
      "Создайте собственное приложение Miro",
      "Экспортируйте в это хранилище",
      "Откройте доску",
      "После этого",
    ]);
    expect(buttons(list[0]!)[0]!.textContent).toBe("Скачать для Windows");
  });
});
