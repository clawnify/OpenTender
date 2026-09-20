// Turning an uploaded file into citable text.
//
// This runs in the Worker, not on a VPS and not in a sandbox, which rules out
// LibreOffice and anything else that shells out. That constraint is mostly a
// gift: PDF and DOCX both have pure-JS readers that work at the edge, and the
// formats that would need a converter (legacy .doc, scanned images) are the two
// we should refuse loudly rather than half-support.

import { unzipSync, strFromU8 } from "fflate";

/** Cap on stored text per document. Beyond this, extraction truncates. */
const MAX_TEXT_CHARS = 4_000_000;

/** Target size of a synthetic block for formats that have no real pages. */
const BLOCK_CHARS = 2_500;

export interface ExtractedPage {
  page_no: number;
  text: string;
}

export interface Extraction {
  pages: ExtractedPage[];
  /** What page_no counts. Honest labelling matters: a DOCX has no page 3. */
  locatorKind: "page" | "block";
}

export class UnsupportedFileError extends Error {}

/** A file whose text we can read without a converter. */
export function isSupported(name: string, mime: string): boolean {
  return detectKind(name, mime) !== null;
}

/**
 * A Word file, and so the only kind that can carry a redline. A PDF has no
 * revision marks to write into: "track changes" is an OOXML feature, not a
 * property of documents in general.
 */
export function isDocx(name: string, mime: string): boolean {
  return detectKind(name, mime) === "docx";
}

type Kind = "pdf" | "docx" | "text";

function detectKind(name: string, mime: string): Kind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return "docx";
  }
  if (mime.startsWith("text/") || ext === "txt" || ext === "md") return "text";
  return null;
}

export async function extract(
  data: ArrayBuffer,
  name: string,
  mime: string,
): Promise<Extraction> {
  const kind = detectKind(name, mime);
  switch (kind) {
    case "pdf":
      return { pages: await extractPdf(data), locatorKind: "page" };
    case "docx":
      return { pages: toBlocks(extractDocx(data)), locatorKind: "block" };
    case "text":
      return { pages: toBlocks(new TextDecoder().decode(data)), locatorKind: "block" };
    default:
      throw new UnsupportedFileError(
        `${name}: only PDF, DOCX and plain text can be read. Legacy .doc and scanned images have no text layer — convert to PDF (with OCR if scanned) and upload that.`,
      );
  }
}

/**
 * unpdf ships a serverless build of PDF.js, so this is a real per-page text
 * layer rather than a heuristic. Pages are 1-indexed to match what a reader
 * sees in a viewer — the number a lawyer will check the citation against.
 */
async function extractPdf(data: ArrayBuffer): Promise<ExtractedPage[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((t, i) => ({ page_no: i + 1, text: t ?? "" }));

  if (pages.every((p) => p.text.trim() === "")) {
    throw new UnsupportedFileError(
      "this PDF has no text layer — it is probably a scan. Run OCR on it and upload the searchable PDF.",
    );
  }
  return pages;
}

/**
 * A .docx is a zip of XML. We want the paragraph text in document order and
 * nothing else, so we read the runs (<w:t>) and treat each paragraph (<w:p>)
 * as a line — no XML parser needed for a shape this fixed, and none exists at
 * the edge without pulling in a large dependency.
 */
function extractDocx(data: ArrayBuffer): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(data), { filter: (f) => f.name === "word/document.xml" });
  } catch {
    throw new UnsupportedFileError("this file is not a readable .docx (the archive could not be opened).");
  }

  const xml = files["word/document.xml"];
  if (!xml) {
    throw new UnsupportedFileError("this .docx has no word/document.xml — it may be a .doc renamed, which has no text layer we can read.");
  }

  return strFromU8(xml)
    .split(/<w:p[\s>]/)
    .map((para) =>
      Array.from(para.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g))
        .map((m) => decodeXmlEntities(m[1]))
        .join(""),
    )
    .filter((line) => line.trim() !== "")
    .join("\n");
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * Split page-less text into stable blocks on paragraph boundaries.
 *
 * Blocks must be *stable*: a citation stored today has to resolve to the same
 * block when the same file is re-extracted, so the split depends only on the
 * text, never on when or how it was uploaded.
 */
export function toBlocks(text: string): ExtractedPage[] {
  const clipped = text.slice(0, MAX_TEXT_CHARS);
  const pages: ExtractedPage[] = [];
  let current = "";

  for (const para of clipped.split(/\n/)) {
    // Keep an oversized paragraph whole rather than splitting mid-sentence —
    // a quote that straddles a block boundary would be unverifiable.
    if (current && current.length + para.length + 1 > BLOCK_CHARS) {
      pages.push({ page_no: pages.length + 1, text: current });
      current = "";
    }
    current = current ? `${current}\n${para}` : para;
  }
  if (current.trim() !== "" || pages.length === 0) {
    pages.push({ page_no: pages.length + 1, text: current });
  }
  return pages;
}
