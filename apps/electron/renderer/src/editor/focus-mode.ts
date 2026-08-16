import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { ParagraphDocument } from "./paragraph-document.js";
import type { ParagraphEditor } from "./paragraph-editor.js";

interface FocusState {
  enabled: boolean;
  paragraphId: string | null;
  decorations: DecorationSet;
}

const focusTargetEffect = StateEffect.define<{ enabled: boolean; paragraphId: string | null }>();

function focusDecorations(state: Pick<FocusState, "enabled" | "paragraphId">, document: ParagraphDocument): DecorationSet {
  if (!state.enabled || !state.paragraphId) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const paragraph of document.ranges()) {
    const className = paragraph.id === state.paragraphId ? "lightee-focus-current" : "lightee-focus-dim";
    if (paragraph.start < paragraph.end) {
      builder.add(paragraph.start, paragraph.end, Decoration.mark({ class: className }));
    } else {
      builder.add(paragraph.start, paragraph.start, Decoration.line({ class: className }));
    }
  }
  return builder.finish();
}

const focusStateField = StateField.define<FocusState>({
  create: () => ({ enabled: false, paragraphId: null, decorations: Decoration.none }),
  update(value, transaction) {
    const effect = transaction.effects.find((candidate) => candidate.is(focusTargetEffect));
    if (!effect && !transaction.docChanged) return value;
    const next = effect ? effect.value : { enabled: value.enabled, paragraphId: value.paragraphId };
    const document = ParagraphDocument.fromText(transaction.state.doc.toString());
    return {
      ...next,
      decorations: focusDecorations(next, document),
    };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function focusModeExtension(): Extension {
  return focusStateField;
}

export function setFocusTarget(view: EditorView, enabled: boolean, paragraphId: string | null): void {
  view.dispatch({ effects: focusTargetEffect.of({ enabled, paragraphId }) });
}

export interface BilingualFocusCoordinatorOptions {
  root: HTMLElement;
  source: ParagraphEditor;
  translation: ParagraphEditor;
  onParagraphChange?: (paragraphId: string | null) => void;
}

export class BilingualFocusCoordinator {
  private readonly root: HTMLElement;
  private readonly source: ParagraphEditor;
  private readonly translation: ParagraphEditor;
  private enabled = true;
  private allowed = true;
  private active = false;
  private paused = false;
  private currentParagraphId: string | null = null;

  private readonly onParagraphChange?: (paragraphId: string | null) => void;

  constructor(options: BilingualFocusCoordinatorOptions) {
    this.root = options.root;
    this.source = options.source;
    this.translation = options.translation;
    this.onParagraphChange = options.onParagraphChange;
    this.translation.view.dom.addEventListener("keydown", this.onKeyDown);
    this.translation.view.scrollDOM.addEventListener("scroll", this.onTranslationScroll, { passive: true });
    this.updateRootState();
  }

  handleTranslationUpdate(update: ViewUpdate): void {
    if (update.focusChanged) {
      if (!update.view.hasFocus) {
        this.active = false;
        this.clearTargets();
      } else if (this.allowed && this.enabled) {
        this.active = true;
        this.paused = false;
        this.syncCurrentParagraph();
      }
    }
    if (!update.view.hasFocus || !this.allowed) return;

    const userEditing = update.docChanged || update.selectionSet || update.transactions.some((transaction) => (
      transaction.isUserEvent("input") ||
      transaction.isUserEvent("delete") ||
      transaction.isUserEvent("undo") ||
      transaction.isUserEvent("redo")
    ));
    if (userEditing) {
      this.enabled = true;
      this.active = true;
      this.paused = false;
      this.syncCurrentParagraph();
    }
  }

  setViewAllowed(allowed: boolean): void {
    this.allowed = allowed;
    if (!allowed) {
      this.active = false;
      this.clearTargets();
    } else if (this.translation.view.hasFocus) {
      this.enabled = true;
      this.paused = false;
      this.active = true;
      this.syncCurrentParagraph();
    }
    this.updateRootState();
  }

  setPreferenceEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.active = false;
      this.paused = false;
      this.clearTargets();
    } else if (this.allowed && this.translation.view.hasFocus) {
      this.active = true;
      this.paused = false;
      this.syncCurrentParagraph();
    }
    this.updateRootState();
  }

  resetAfterDocumentChange(): void {
    this.currentParagraphId = null;
    if (this.active && this.allowed && this.enabled && !this.paused) this.syncCurrentParagraph();
  }

  destroy(): void {
    this.translation.view.dom.removeEventListener("keydown", this.onKeyDown);
    this.translation.view.scrollDOM.removeEventListener("scroll", this.onTranslationScroll);
    this.clearTargets();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.enabled = false;
    this.active = false;
    this.paused = false;
    this.clearTargets();
  };

  private readonly onTranslationScroll = (): void => {
    if (!this.active || !this.allowed) return;
    this.paused = true;
    this.updateRootState();
  };

  private syncCurrentParagraph(): void {
    if (!this.active || !this.allowed || !this.enabled || this.paused) return;
    const selection = this.translation.view.state.selection.main;
    if (!selection.empty) {
      this.clearTargets();
      return;
    }
    const paragraph = this.translation.getDocument().paragraphAt(selection.head);
    if (paragraph.id === this.currentParagraphId) {
      this.updateRootState();
      return;
    }
    this.currentParagraphId = paragraph.id;
    this.onParagraphChange?.(paragraph.id);
    this.translation.setFocus(true, paragraph.id);
    const sourceParagraph = this.source.getDocument().paragraphById(paragraph.id) ?? this.source.getDocument().ranges()[paragraph.index];
    if (sourceParagraph) {
      this.source.setFocus(true, sourceParagraph.id);
      this.source.view.dispatch({ effects: EditorView.scrollIntoView(sourceParagraph.start, { y: "center" }) });
    } else {
      this.source.setFocus(false, null);
    }
    this.updateRootState();
  }

  private clearTargets(): void {
    this.translation.setFocus(false, null);
    this.source.setFocus(false, null);
    this.currentParagraphId = null;
    this.onParagraphChange?.(null);
    this.updateRootState();
  }

  private updateRootState(): void {
    this.root.dataset.focusMode = this.allowed && this.enabled ? "on" : "off";
    this.root.dataset.focusActive = String(this.active && this.allowed && this.enabled);
    this.root.dataset.focusPaused = String(this.paused);
    if (this.currentParagraphId) this.root.dataset.focusParagraph = this.currentParagraphId;
    else delete this.root.dataset.focusParagraph;
  }
}
