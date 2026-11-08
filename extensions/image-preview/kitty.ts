import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getCellDimensions, getImageDimensions } from "@earendil-works/pi-tui";
import type { PreviewImage } from "./images.js";

// Kitty Unicode placeholders for tmux. The diacritic table and the transmit
// envelope are adapted from jcode (MIT, Copyright (c) 2025 Jeremy Huang),
// crates/jcode-tui-mermaid/src/mermaid_viewport.rs; the table itself comes from
// https://sw.kovidgoyal.net/kitty/graphics-protocol/ (rowcolumn-diacritics.txt).
const DIACRITICS: string[] = [
  "\u{305}",
  "\u{30D}",
  "\u{30E}",
  "\u{310}",
  "\u{312}",
  "\u{33D}",
  "\u{33E}",
  "\u{33F}",
  "\u{346}",
  "\u{34A}",
  "\u{34B}",
  "\u{34C}",
  "\u{350}",
  "\u{351}",
  "\u{352}",
  "\u{357}",
  "\u{35B}",
  "\u{363}",
  "\u{364}",
  "\u{365}",
  "\u{366}",
  "\u{367}",
  "\u{368}",
  "\u{369}",
  "\u{36A}",
  "\u{36B}",
  "\u{36C}",
  "\u{36D}",
  "\u{36E}",
  "\u{36F}",
  "\u{483}",
  "\u{484}",
  "\u{485}",
  "\u{486}",
  "\u{487}",
  "\u{592}",
  "\u{593}",
  "\u{594}",
  "\u{595}",
  "\u{597}",
  "\u{598}",
  "\u{599}",
  "\u{59C}",
  "\u{59D}",
  "\u{59E}",
  "\u{59F}",
  "\u{5A0}",
  "\u{5A1}",
  "\u{5A8}",
  "\u{5A9}",
  "\u{5AB}",
  "\u{5AC}",
  "\u{5AF}",
  "\u{5C4}",
  "\u{610}",
  "\u{611}",
  "\u{612}",
  "\u{613}",
  "\u{614}",
  "\u{615}",
  "\u{616}",
  "\u{617}",
  "\u{657}",
  "\u{658}",
  "\u{659}",
  "\u{65A}",
  "\u{65B}",
  "\u{65D}",
  "\u{65E}",
  "\u{6D6}",
  "\u{6D7}",
  "\u{6D8}",
  "\u{6D9}",
  "\u{6DA}",
  "\u{6DB}",
  "\u{6DC}",
  "\u{6DF}",
  "\u{6E0}",
  "\u{6E1}",
  "\u{6E2}",
  "\u{6E4}",
  "\u{6E7}",
  "\u{6E8}",
  "\u{6EB}",
  "\u{6EC}",
  "\u{730}",
  "\u{732}",
  "\u{733}",
  "\u{735}",
  "\u{736}",
  "\u{73A}",
  "\u{73D}",
  "\u{73F}",
  "\u{740}",
  "\u{741}",
  "\u{743}",
  "\u{745}",
  "\u{747}",
  "\u{749}",
  "\u{74A}",
  "\u{7EB}",
  "\u{7EC}",
  "\u{7ED}",
  "\u{7EE}",
  "\u{7EF}",
  "\u{7F0}",
  "\u{7F1}",
  "\u{7F3}",
  "\u{816}",
  "\u{817}",
  "\u{818}",
  "\u{819}",
  "\u{81B}",
  "\u{81C}",
  "\u{81D}",
  "\u{81E}",
  "\u{81F}",
  "\u{820}",
  "\u{821}",
  "\u{822}",
  "\u{823}",
  "\u{825}",
  "\u{826}",
  "\u{827}",
  "\u{829}",
  "\u{82A}",
  "\u{82B}",
  "\u{82C}",
  "\u{82D}",
  "\u{951}",
  "\u{953}",
  "\u{954}",
  "\u{F82}",
  "\u{F83}",
  "\u{F86}",
  "\u{F87}",
  "\u{135D}",
  "\u{135E}",
  "\u{135F}",
  "\u{17DD}",
  "\u{193A}",
  "\u{1A17}",
  "\u{1A75}",
  "\u{1A76}",
  "\u{1A77}",
  "\u{1A78}",
  "\u{1A79}",
  "\u{1A7A}",
  "\u{1A7B}",
  "\u{1A7C}",
  "\u{1B6B}",
  "\u{1B6D}",
  "\u{1B6E}",
  "\u{1B6F}",
  "\u{1B70}",
  "\u{1B71}",
  "\u{1B72}",
  "\u{1B73}",
  "\u{1CD0}",
  "\u{1CD1}",
  "\u{1CD2}",
  "\u{1CDA}",
  "\u{1CDB}",
  "\u{1CE0}",
  "\u{1DC0}",
  "\u{1DC1}",
  "\u{1DC3}",
  "\u{1DC4}",
  "\u{1DC5}",
  "\u{1DC6}",
  "\u{1DC7}",
  "\u{1DC8}",
  "\u{1DC9}",
  "\u{1DCB}",
  "\u{1DCC}",
  "\u{1DD1}",
  "\u{1DD2}",
  "\u{1DD3}",
  "\u{1DD4}",
  "\u{1DD5}",
  "\u{1DD6}",
  "\u{1DD7}",
  "\u{1DD8}",
  "\u{1DD9}",
  "\u{1DDA}",
  "\u{1DDB}",
  "\u{1DDC}",
  "\u{1DDD}",
  "\u{1DDE}",
  "\u{1DDF}",
  "\u{1DE0}",
  "\u{1DE1}",
  "\u{1DE2}",
  "\u{1DE3}",
  "\u{1DE4}",
  "\u{1DE5}",
  "\u{1DE6}",
  "\u{1DFE}",
  "\u{20D0}",
  "\u{20D1}",
  "\u{20D4}",
  "\u{20D5}",
  "\u{20D6}",
  "\u{20D7}",
  "\u{20DB}",
  "\u{20DC}",
  "\u{20E1}",
  "\u{20E7}",
  "\u{20E9}",
  "\u{20F0}",
  "\u{2CEF}",
  "\u{2CF0}",
  "\u{2CF1}",
  "\u{2DE0}",
  "\u{2DE1}",
  "\u{2DE2}",
  "\u{2DE3}",
  "\u{2DE4}",
  "\u{2DE5}",
  "\u{2DE6}",
  "\u{2DE7}",
  "\u{2DE8}",
  "\u{2DE9}",
  "\u{2DEA}",
  "\u{2DEB}",
  "\u{2DEC}",
  "\u{2DED}",
  "\u{2DEE}",
  "\u{2DEF}",
  "\u{2DF0}",
  "\u{2DF1}",
  "\u{2DF2}",
  "\u{2DF3}",
  "\u{2DF4}",
  "\u{2DF5}",
  "\u{2DF6}",
  "\u{2DF7}",
  "\u{2DF8}",
  "\u{2DF9}",
  "\u{2DFA}",
  "\u{2DFB}",
  "\u{2DFC}",
  "\u{2DFD}",
  "\u{2DFE}",
  "\u{2DFF}",
  "\u{A66F}",
  "\u{A67C}",
  "\u{A67D}",
  "\u{A6F0}",
  "\u{A6F1}",
  "\u{A8E0}",
  "\u{A8E1}",
  "\u{A8E2}",
  "\u{A8E3}",
  "\u{A8E4}",
  "\u{A8E5}",
  "\u{A8E6}",
  "\u{A8E7}",
  "\u{A8E8}",
  "\u{A8E9}",
  "\u{A8EA}",
  "\u{A8EB}",
  "\u{A8EC}",
  "\u{A8ED}",
  "\u{A8EE}",
  "\u{A8EF}",
  "\u{A8F0}",
  "\u{A8F1}",
  "\u{AAB0}",
  "\u{AAB2}",
  "\u{AAB3}",
  "\u{AAB7}",
  "\u{AAB8}",
  "\u{AABE}",
  "\u{AABF}",
  "\u{AAC1}",
  "\u{FE20}",
  "\u{FE21}",
  "\u{FE22}",
  "\u{FE23}",
  "\u{FE24}",
  "\u{FE25}",
  "\u{FE26}",
  "\u{10A0F}",
  "\u{10A38}",
  "\u{1D185}",
  "\u{1D186}",
  "\u{1D187}",
  "\u{1D188}",
  "\u{1D189}",
  "\u{1D1AA}",
  "\u{1D1AB}",
  "\u{1D1AC}",
  "\u{1D1AD}",
  "\u{1D242}",
  "\u{1D243}",
  "\u{1D244}",
];
const PLACEHOLDER = "\u{10EEEE}";
const uploaded = new Set<string>();
let available: boolean | undefined;
let unavailableReason = "";

/** Kitty graphics can work through tmux only with DCS passthrough and RGB. */
export function kittyTmuxAvailable(): boolean {
  if (available !== undefined) return available;
  available = false;
  if (!process.stdout.isTTY || !process.env.TMUX) return false;
  const kitty = Boolean(process.env.KITTY_WINDOW_ID) || /kitty/i.test(process.env.TERM_PROGRAM ?? "") || /kitty/i.test(process.env.TERM ?? "");
  if (!kitty) { unavailableReason = "not running inside Kitty"; return false; }
  try {
    const features = execFileSync("tmux", ["display-message", "-p", "#{client_termfeatures}"], { encoding: "utf8", timeout: 400 });
    if (!/\bRGB\b/.test(features)) { unavailableReason = "tmux client does not advertise RGB truecolor"; return false; }
    const option = execFileSync("tmux", ["show-options", "-Apv", "allow-passthrough"], { encoding: "utf8", timeout: 400 }).trim();
    if (option !== "on" && option !== "all") { unavailableReason = "tmux allow-passthrough is off (tmux set -g allow-passthrough on)"; return false; }
    available = true;
  } catch { unavailableReason = "tmux/Kittty capability check failed"; }
  return available;
}

export function kittyTmuxReason(): string { return unavailableReason; }

export interface KittyPlacement { id: number; cols: number; rows: number }

/** Fit the image into a cell box, preserving the pixel aspect ratio. */
export function planKittyPlacement(item: PreviewImage, maxCols: number, maxRows: number): KittyPlacement | undefined {
  if (item.mimeType !== "image/png") return;
  const size = getImageDimensions(item.data, item.mimeType);
  if (!size || !size.widthPx || !size.heightPx) return;
  const cell = getCellDimensions();
  const scale = Math.min((maxCols * cell.widthPx) / size.widthPx, (maxRows * cell.heightPx) / size.heightPx);
  const cols = Math.max(1, Math.min(maxCols, Math.round((size.widthPx * scale) / cell.widthPx)));
  const rows = Math.max(1, Math.min(maxRows, Math.round((size.heightPx * scale) / cell.heightPx)));
  if (cols > DIACRITICS.length || rows > DIACRITICS.length) return;
  const digest = createHash("sha256").update(item.data).update(`:${cols}x${rows}`).digest();
  const id = (digest.readUInt32BE(0) & 0xfffffe) + 1;
  return { id, cols, rows };
}

function diacritic(index: number): string {
  return DIACRITICS[index] ?? DIACRITICS[0];
}

export function kittyPlaceholderLines(placement: KittyPlacement): string[] {
  const { id, cols, rows } = placement;
  const color = `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = color;
    for (let col = 0; col < cols; col++) line += PLACEHOLDER + diacritic(row) + diacritic(col);
    lines.push(line + "\x1b[39m");
  }
  return lines;
}

/** Build the tmux DCS envelope carrying a Kitty virtual placement. */
export function kittyUploadPayload(item: PreviewImage, placement: KittyPlacement): string {
  const raw = Buffer.from(item.data, "base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < raw.length; offset += 3072) chunks.push(raw.subarray(offset, offset + 3072).toString("base64"));
  const parts: string[] = ["\x1bPtmux;"];
  for (let index = 0; index < chunks.length; index++) {
    const first = index === 0;
    const last = index === chunks.length - 1;
    const params = first
      ? `a=T,U=1,f=100,q=2,i=${placement.id},c=${placement.cols},r=${placement.rows},m=${last ? 0 : 1}`
      : `q=2,m=${last ? 0 : 1}`;
    parts.push(`\x1b\x1b_G${params};${chunks[index]}\x1b\x1b\\`);
  }
  parts.push("\x1b\\");
  return parts.join("");
}

/** Transmit once per image/size, wrapped in tmux's DCS passthrough envelope. */
export function uploadKittyPlacement(item: PreviewImage, placement: KittyPlacement): void {
  const key = `${placement.id}:${placement.cols}x${placement.rows}`;
  if (uploaded.has(key)) return;
  process.stdout.write(kittyUploadPayload(item, placement));
  if (uploaded.size > 200) {
    const oldest = uploaded.values().next().value;
    if (oldest) uploaded.delete(oldest);
  }
  uploaded.add(key);
}

/** pi-tui component that paints Kitty placeholders as ordinary cells. */
export class KittyPlaceholderImage {
  private lines?: string[];
  private width?: number;
  constructor(private item: PreviewImage, private maxCols: number, private maxRows: number) {}
  invalidate() { this.lines = undefined; this.width = undefined; }
  render(width: number): string[] {
    if (this.lines && this.width === width) return this.lines;
    const placement = planKittyPlacement(this.item, Math.max(1, Math.min(width - 2, this.maxCols)), this.maxRows);
    if (!placement) return [];
    uploadKittyPlacement(this.item, placement);
    this.lines = kittyPlaceholderLines(placement);
    this.width = width;
    return this.lines;
  }
}
