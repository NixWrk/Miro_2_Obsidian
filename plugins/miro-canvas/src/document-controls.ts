import { describeLocalDocument, navigateDocument, openLocalDocument, type DocumentHost, type LocalDocument } from "./document-viewer";
import { words } from "./i18n";

/** Small local-file inspector. Rendering stays in Obsidian's native file viewer. */
export class DocumentControls {
  readonly element: HTMLElement;
  private disposed = false;
  private openSequence = 0;
  private current: LocalDocument | null;
  private readonly status: HTMLElement;
  private readonly pageInput: HTMLInputElement;
  private readonly fitInput: HTMLSelectElement;

  constructor(private readonly host: DocumentHost, file: unknown, document: Document, subpath?: unknown) {
    this.current = describeLocalDocument(file, { subpath });
    this.element = document.createElement("section");
    this.element.className = "miro-canvas-document-controls";
    const heading = document.createElement("h3");
    heading.textContent = this.current?.title ?? words().documents.unavailableTitle;
    this.element.append(heading);
    this.status = document.createElement("p");
    this.status.setAttribute("role", "status");
    this.status.textContent = this.current ? words().documents.localFileHint : words().documents.invalidPath;
    this.element.append(this.status);
    this.pageInput = document.createElement("input");
    this.pageInput.type = "number";
    this.pageInput.min = "1";
    this.pageInput.max = "1000000";
    this.pageInput.step = "1";
    this.pageInput.value = String(this.current?.page ?? 1);
    this.pageInput.setAttribute("aria-label", words().documents.pageAriaLabel);
    this.fitInput = document.createElement("select");
    this.fitInput.setAttribute("aria-label", words().documents.fitAriaLabel);
    for (const [value, label] of [["page", words().documents.fitPage], ["width", words().documents.fitWidth]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.fitInput.append(option);
    }
    const button = (label: string, click: () => void): void => {
      const control = document.createElement("button");
      control.type = "button";
      control.textContent = label;
      control.disabled = this.current === null;
      control.addEventListener("click", click);
      this.element.append(control);
    };
    if (this.current?.kind === "pdf") {
      this.element.append(this.pageInput, this.fitInput);
      button(words().documents.previousPage, () => this.step(-1));
      button(words().documents.nextPage, () => this.step(1));
      button(words().documents.openPage, () => { void this.open(); });
    }
    button(words().documents.openOriginal, () => { void this.open(); });
  }

  private step(delta: number): void {
    if (!this.current || this.disposed) return;
    const requested = this.requestedDocument();
    if (requested === null) return;
    this.current = navigateDocument(requested, delta);
    this.pageInput.value = String(this.current.page);
    void this.openCurrent();
  }

  private requestedDocument(): LocalDocument | null {
    if (!this.current || this.disposed) return null;
    const requestedPage = Number(this.pageInput.value);
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 1_000_000) {
      this.status.textContent = words().documents.invalidPageNumber;
      return null;
    }
    return describeLocalDocument(this.current.path, {
      page: requestedPage,
      fit: this.fitInput.value === "width" ? "width" : "page",
      subpath: this.current.subpath,
    });
  }

  private async openCurrent(): Promise<void> {
    if (!this.current || this.disposed) return;
    const sequence = ++this.openSequence;
    const result = await openLocalDocument(this.host, this.current.path, {
      page: this.current.page, fit: this.current.fit, subpath: this.current.subpath,
    });
    if (this.disposed || sequence !== this.openSequence) return;
    if (result.ok) {
      this.current = result.document;
      this.status.textContent = words().documents.openedInViewer;
    } else {
      this.status.textContent = result.reason === "missing-file" ? words().documents.missingFile
        : words().documents.openFailed;
    }
  }

  private async open(): Promise<void> {
    const requested = this.requestedDocument();
    if (requested === null) return;
    this.current = requested;
    await this.openCurrent();
  }

  dispose(): void { this.disposed = true; this.element.remove(); }
}
