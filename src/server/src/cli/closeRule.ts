import { homedir } from "node:os";
import path from "node:path";

/** One entry of `openDocuments` in the `get_model_info` answer. */
export interface OpenDocument {
  title?: unknown;
  path?: unknown;
  isModified?: unknown;
}

export interface CloseVerdict {
  /** True only when Revit may be closed without losing work. */
  ok: boolean;
  /** One line per problem. Empty when `ok` is true. */
  reasons: string[];
}

/** `%USERPROFILE%\Documents\RevitMCP`, the only place where documents may be open when Revit is closed. */
export function defaultTestFolder(): string {
  return path.win32.join(process.env["USERPROFILE"] || homedir(), "Documents", "RevitMCP");
}

/** True when `file` is inside `folder` (not the folder itself). Case-insensitive, and `..` and `/` are normalized. */
export function isInsideFolder(file: string, folder: string): boolean {
  const normalize = (value: string): string => path.win32.resolve(value).toLowerCase();
  const root = normalize(folder).replace(/[\\/]+$/, "");
  return normalize(file).startsWith(root + "\\");
}

/** A project template file. A document on one is what a `save_project_template` that failed to save back leaves behind. */
const TEMPLATE_EXTENSION = /\.rte$/i;

/**
 * Decides from `openDocuments` alone whether Revit may be closed: every document must be saved (`isModified` false),
 * live inside `folder` and not be on a project template file. An empty list passes. Anything that does not look as
 * expected is refused.
 */
export function checkCanClose(openDocuments: unknown, folder: string = defaultTestFolder()): CloseVerdict {
  if (!Array.isArray(openDocuments)) {
    return { ok: false, reasons: ["The answer of get_model_info has no openDocuments list."] };
  }

  const reasons: string[] = [];
  for (const entry of openDocuments as unknown[]) {
    const document = (typeof entry === "object" && entry !== null ? entry : {}) as OpenDocument;
    const title = typeof document.title === "string" && document.title.length > 0 ? document.title : "(untitled)";

    if (document.isModified !== false) {
      reasons.push(`Document "${title}" has unsaved changes.`);
    }
    if (typeof document.path !== "string" || document.path.length === 0) {
      reasons.push(`Document "${title}" is not saved to a file.`);
    } else {
      if (!isInsideFolder(document.path, folder)) {
        reasons.push(`Document "${title}" is outside ${folder}: ${document.path}`);
      }
      if (TEMPLATE_EXTENSION.test(document.path)) {
        reasons.push(
          `Document "${title}" is on a project template file, ${document.path}: a save_project_template could not save it back to its project. Save it over the project .rvt in Revit, or close it, before Revit is closed.`,
        );
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}
