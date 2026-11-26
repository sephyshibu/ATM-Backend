// Checks a dossier file by its content, not its name or the browser's word for it. Only PDF and Word files are
// accepted. Each type is recognised by its first bytes (its "magic number"); a file whose content doesn't match
// its extension is refused. Files that can run code are refused too: Word files with macros, and PDFs with
// JavaScript or launch actions. (For virus scanning, switch on GuardDuty Malware Protection on the S3 bucket.)

export type DossierType = "pdf" | "docx" | "doc"

export const DOSSIER_TYPES: Record<DossierType, { label: string; contentType: string; ext: string }> = {
  pdf: { label: "PDF", contentType: "application/pdf", ext: "pdf" },
  docx: { label: "Word (.docx)", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  doc: { label: "Word 97–2003 (.doc)", contentType: "application/msword", ext: "doc" },
}

const PDF = Buffer.from("%PDF-")
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** What the bytes are, whatever the name says. */
export function sniff(buf: Buffer): DossierType | "html" | "zip" | null {
  // A PDF may have a little junk before its header (allowed up to 1 KB).
  if (buf.subarray(0, 1024).indexOf(PDF) !== -1) return "pdf"
  if (buf.subarray(0, 4).equals(ZIP)) return buf.indexOf("word/document.xml") !== -1 ? "docx" : "zip"
  if (buf.subarray(0, 8).equals(OLE)) return "doc"
  const head = buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase()
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<head") || head.includes("<body")) return "html"
  return null
}

export const extOf = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? ""

/** "../../Glow Co – dossier (v2).PDF" → "Glow Co – dossier (v2).PDF": no folders, no control characters, ≤ 150 characters. */
export function safeFileName(raw: string, fallback = "dossier") {
  const base = (raw.split(/[\\/]/).pop() ?? "").replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim()
  if (!base || /^\.+$/.test(base)) return fallback
  if (base.length <= 150) return base
  const ext = extOf(base)
  return `${base.slice(0, 140 - ext.length)}….${ext}`
}

/**
 * The checked type, or the exact reason the file can't be a dossier. `fromName` is the uploaded name (checked
 * against the content); a fetched file has none.
 */
export function checkDossier(buf: Buffer, fromName: string | null, maxBytes: number): { type: DossierType } | { error: string } {
  if (!buf.length) return { error: "The file is empty." }
  if (buf.length > maxBytes) return { error: `The file is ${mb(buf.length)}; the limit is ${mb(maxBytes)}.` }
  const type = sniff(buf)
  if (type === "html") return { error: "This is a web page, not a file." }
  if (type === "zip") return { error: "This is a ZIP file, not a Word document. Upload the PDF or Word file itself." }
  if (!type) return { error: "Only PDF and Word files (.pdf, .docx, .doc) can be attached." }
  if (fromName) {
    const ext = extOf(fromName)
    if (["docm", "dotm"].includes(ext)) return { error: "Word files with macros (.docm) aren't accepted. Save it as .docx or PDF and upload that." }
    if (ext !== type) return { error: `The file is named .${ext || "(no extension)"} but it's really a ${DOSSIER_TYPES[type].label} file. Rename it or export it again.` }
  }
  if (type === "docx" && (buf.indexOf("vbaProject.bin") !== -1 || buf.indexOf("macroEnabled") !== -1)) return { error: "This Word file contains macros, which aren't accepted. Save it as .docx without macros, or as PDF." }
  if (type === "doc" && (buf.indexOf(Buffer.from("_VBA_PROJECT", "utf16le")) !== -1 || buf.indexOf(Buffer.from("Macros", "utf16le")) !== -1)) return { error: "This Word file contains macros, which aren't accepted. Save it as .docx or PDF." }
  if (type === "pdf") {
    if (!buf.subarray(Math.max(0, buf.length - 2048)).includes("%%EOF")) return { error: "This PDF is incomplete or damaged. Export it again and upload that." }
    if (/\/(JavaScript|JS|Launch)\b/.test(buf.toString("latin1"))) return { error: "This PDF contains scripts or launch actions, which aren't accepted. Print it to a new PDF (Print → Save as PDF) and upload that." }
  }
  return { type }
}

export const mb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

// ---------------------------------------------------------------- Import files (the Excel or CSV behind an import)

export type SheetType = "xlsx" | "csv"

export const SHEET_TYPES: Record<SheetType, { label: string; contentType: string; ext: string }> = {
  xlsx: { label: "Excel (.xlsx)", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  csv: { label: "CSV", contentType: "text/csv; charset=utf-8", ext: "csv" },
}

/**
 * The checked type of an imported file, or why it can't be kept. Checked by content: an .xlsx must be a real
 * Excel workbook without macros; a .csv/.txt must be plain text (no binary bytes).
 */
export function checkSheet(buf: Buffer, fromName: string, maxBytes: number): { type: SheetType } | { error: string } {
  if (!buf.length) return { error: "The file is empty." }
  if (buf.length > maxBytes) return { error: `The file is ${mb(buf.length)}; the limit is ${mb(maxBytes)}.` }
  const ext = extOf(fromName)
  if (["xlsm", "xltm", "xlsb", "xls"].includes(ext)) return { error: "Only .xlsx and .csv files are kept. Save the sheet as .xlsx (without macros) or .csv." }
  if (buf.subarray(0, 4).equals(ZIP)) {
    if (buf.indexOf("xl/workbook.xml") === -1) return { error: "This ZIP file isn't an Excel workbook." }
    if (buf.indexOf("vbaProject.bin") !== -1 || buf.indexOf("macroEnabled") !== -1) return { error: "This workbook contains macros, which aren't kept. Save it as .xlsx without macros." }
    if (ext !== "xlsx") return { error: `The file is named .${ext || "(no extension)"} but it's really an Excel (.xlsx) file.` }
    return { type: "xlsx" }
  }
  if (!["csv", "txt"].includes(ext)) return { error: "Only .xlsx and .csv files are kept." }
  if (buf.subarray(0, 8).equals(OLE) || buf.includes(0)) return { error: "This isn't a plain-text CSV file." }
  return { type: "csv" }
}
