/**
 * WebM (Matroska/EBML) duration and splitting, dependency-free, for cutting long
 * MediaRecorder recordings to fit Gemini's per-request audio limits.
 *
 * Chrome's MediaRecorder with a timeslice writes "live" WebM: the Segment and every
 * Cluster have unknown size (all-ones size VINT), there is no SeekHead, Cues or
 * Duration, and a recovered recording may stop in the middle of a block. Parsing
 * walks the element tree once; an unknown-size element ends at the first element
 * that belongs at Segment level, and a truncated trailing element is dropped.
 *
 * A part is rebuilt from whole Clusters: the original EBML header, an unknown-size
 * Segment, Info (with the part's own Duration), Tracks, then the Clusters with
 * their Timecode rebased so the part starts at 0.
 */

export interface WebmPart {
  /** A standalone WebM file. */
  data: Uint8Array<ArrayBuffer>;
  /** ms in the original recording's timeline. */
  startMs: number;
  /** ms in the original recording's timeline. */
  endMs: number;
}

export interface SplitWebmOptions {
  maxPartMs: number;
  overlapMs: number;
}

const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  CodecID: 0x86,
  DefaultDuration: 0x23e383,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  Position: 0xa7,
  PrevSize: 0xab,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
  Void: 0xec,
  Crc32: 0xbf,
} as const;

/** Elements that end an unknown-size Cluster (or other unknown-size master) when met. */
const LEVEL1 = new Set<number>([
  ID.EBML,
  ID.Segment,
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  ID.Cues,
  ID.Tags,
  ID.Chapters,
  ID.Attachments,
]);

/** Cluster children that are dropped: absolute positions, padding, checksums. */
const CLUSTER_DROP = new Set<number>([ID.Timecode, ID.Position, ID.PrevSize, ID.Void, ID.Crc32]);
const INFO_DROP = new Set<number>([ID.Duration, ID.Void, ID.Crc32]);

const UNKNOWN_SIZE = -1;
const DEFAULT_TIMECODE_SCALE = 1_000_000;
const SEGMENT_UNKNOWN_SIZE = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

interface Range {
  start: number;
  end: number;
}

interface ElementHeader {
  id: number;
  /** Data size in bytes, or UNKNOWN_SIZE. */
  size: number;
  /** Offset of the element's ID. */
  start: number;
  dataStart: number;
}

interface TrackInfo {
  codecId: string;
  defaultDurationNs: number;
}

interface BlockRef {
  /** Timecode relative to the cluster, in TimecodeScale ticks. */
  rel: number;
  track: number;
  lacing: number;
  /** Offset of the first byte of frame data. */
  frames: number;
  end: number;
  /** BlockDuration from the enclosing BlockGroup, in ticks. */
  durationTicks: number | null;
}

interface Cluster {
  timecode: number;
  /** Children copied into a rebuilt cluster, adjacent ranges merged. */
  keep: Range[];
  keepBytes: number;
  blocks: BlockRef[];
  startMs: number;
  endMs: number;
}

interface ParsedWebm {
  /** The whole EBML header element. */
  header: Range;
  /** Info children kept in parts (all but Duration, Void and CRC-32). */
  infoChildren: Range[];
  /** Data of the Tracks element. */
  tracksData: Range | null;
  timecodeScale: number;
  clusters: Cluster[];
}

/** Duration in ms: end of the last block (its timecode plus one packet). */
export function webmDurationMs(data: Uint8Array): number {
  return durationOf(parseWebm(data).clusters);
}

/**
 * Cuts a recording into standalone WebM files, each at most `maxPartMs` long, that
 * cover [0, duration] with consecutive parts overlapping by at least `overlapMs`.
 * Cuts fall only on Cluster boundaries, so parts can be a little shorter than
 * `maxPartMs`. A recording that already fits comes back as its own bytes.
 */
export function splitWebm(data: Uint8Array, opts: SplitWebmOptions): WebmPart[] {
  const { maxPartMs, overlapMs } = opts;
  if (!(maxPartMs > 0) || !Number.isFinite(maxPartMs) || !(overlapMs >= 0) || overlapMs >= maxPartMs) {
    throw new RangeError(`splitWebm needs 0 ≤ overlapMs < maxPartMs, got ${overlapMs} and ${maxPartMs}`);
  }
  const parsed = parseWebm(data);
  const durationMs = durationOf(parsed.clusters);
  if (durationMs <= maxPartMs) {
    const own = data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : data.slice();
    return [{ data: own, startMs: 0, endMs: durationMs }];
  }
  const tracksData = parsed.tracksData;
  if (!tracksData) throw new Error('WebM has no Tracks element');
  return planParts(parsed.clusters, maxPartMs, overlapMs).map((p) => ({
    data: buildPart(data, parsed, tracksData, p),
    startMs: p.startMs,
    endMs: p.endMs,
  }));
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface PlannedPart {
  first: number;
  last: number;
  startMs: number;
  endMs: number;
}

function durationOf(clusters: Cluster[]): number {
  return clusters.reduce((max, c) => Math.max(max, c.endMs), 0);
}

/**
 * Greedy: each part takes as many clusters as fit, and the next part starts at the
 * latest cluster that still leaves the required overlap, which maximises its reach.
 */
function planParts(clusters: Cluster[], maxPartMs: number, overlapMs: number): PlannedPart[] {
  const plan: PlannedPart[] = [];
  let first = 0;
  let startMs = 0;
  for (;;) {
    let last = first;
    let endMs = clusters[first]!.endMs;
    if (endMs - startMs > maxPartMs) {
      const at = clusters[first]!.startMs;
      throw new Error(`cannot split WebM into parts of ≤ ${maxPartMs} ms: the cluster at ${at} ms runs to ${endMs} ms`);
    }
    while (last + 1 < clusters.length) {
      const nextEnd = Math.max(endMs, clusters[last + 1]!.endMs);
      if (nextEnd - startMs > maxPartMs) break;
      last++;
      endMs = nextEnd;
    }
    plan.push({ first, last, startMs, endMs });
    if (last === clusters.length - 1) return plan;

    let next = last + 1;
    while (next > first && clusters[next]!.startMs > endMs - overlapMs) next--;
    if (next === first) {
      throw new Error(
        `cannot split WebM into parts of ≤ ${maxPartMs} ms overlapping by ${overlapMs} ms: ` +
          `clusters are too long (part from ${startMs} ms ends at ${endMs} ms)`,
      );
    }
    first = next;
    startMs = clusters[next]!.startMs;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function buildPart(
  data: Uint8Array,
  parsed: ParsedWebm,
  tracksData: Range,
  part: PlannedPart,
): Uint8Array<ArrayBuffer> {
  const out = new ByteWriter();
  out.push(data.subarray(parsed.header.start, parsed.header.end));
  out.push(SEGMENT_UNKNOWN_SIZE);

  const durationTicks = ((part.endMs - part.startMs) * 1e6) / parsed.timecodeScale;
  const duration = [...idBytes(ID.Duration), 0x88, ...float64Bytes(durationTicks)];
  const infoBytes = parsed.infoChildren.reduce((n, r) => n + r.end - r.start, 0) + duration.length;
  out.push(elementHeader(ID.Info, infoBytes));
  for (const r of parsed.infoChildren) out.push(data.subarray(r.start, r.end));
  out.push(duration);

  out.push(elementHeader(ID.Tracks, tracksData.end - tracksData.start));
  out.push(data.subarray(tracksData.start, tracksData.end));

  const offset = part.first === 0 ? 0 : parsed.clusters[part.first]!.timecode;
  for (let i = part.first; i <= part.last; i++) {
    const cluster = parsed.clusters[i]!;
    const tc = uintBytes(Math.max(0, cluster.timecode - offset));
    const timecode = [...idBytes(ID.Timecode), ...sizeVint(tc.length), ...tc];
    out.push(elementHeader(ID.Cluster, timecode.length + cluster.keepBytes));
    out.push(timecode);
    for (const r of cluster.keep) out.push(data.subarray(r.start, r.end));
  }
  return out.finish();
}

class ByteWriter {
  private pieces: Uint8Array[] = [];
  private length = 0;

  push(bytes: Uint8Array | readonly number[]): void {
    const piece = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.pieces.push(piece);
    this.length += piece.length;
  }

  finish(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const piece of this.pieces) {
      out.set(piece, at);
      at += piece.length;
    }
    return out;
  }
}

function elementHeader(id: number, size: number): number[] {
  return [...idBytes(id), ...sizeVint(size)];
}

/** IDs keep their VINT marker, so their value is already the encoded bytes. */
function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

/** Shortest size VINT; all-ones is reserved for "unknown", hence the - 1. */
function sizeVint(size: number): number[] {
  let length = 1;
  while (length < 8 && size >= 2 ** (7 * length) - 1) length++;
  const out = new Array<number>(length).fill(0);
  let v = size;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] = out[0]! | (0x80 >> (length - 1));
  return out;
}

function uintBytes(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return out;
}

function float64Bytes(value: number): number[] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return [...new Uint8Array(view.buffer)];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseWebm(data: Uint8Array): ParsedWebm {
  const ebml = readHeader(data, 0, data.length);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === UNKNOWN_SIZE || ebml.dataStart + ebml.size > data.length) {
    throw new Error('not a WebM file: no EBML header');
  }
  const headerEnd = ebml.dataStart + ebml.size;
  walk(data, ebml.dataStart, headerEnd, false, (h, end) => {
    if (h.id !== ID.DocType) return;
    const docType = new TextDecoder().decode(data.subarray(h.dataStart, end)).replace(/\0+$/, '');
    if (docType !== 'webm' && docType !== 'matroska') {
      throw new Error(`not a WebM file: DocType is "${docType}"`);
    }
  });

  const parsed: ParsedWebm = {
    header: { start: 0, end: headerEnd },
    infoChildren: [],
    tracksData: null,
    timecodeScale: DEFAULT_TIMECODE_SCALE,
    clusters: [],
  };
  const trackInfo = new Map<number, TrackInfo>();

  let segment: ElementHeader | null = null;
  for (let pos = headerEnd; pos < data.length; ) {
    const h = readHeader(data, pos, data.length);
    if (!h) break;
    if (h.id === ID.Segment) {
      segment = h;
      break;
    }
    if (h.size === UNKNOWN_SIZE) break;
    pos = h.dataStart + h.size;
  }
  if (segment) parseSegment(data, segment, parsed, trackInfo);

  if (parsed.clusters.length === 0) throw new Error('WebM has no clusters with complete blocks');
  for (const cluster of parsed.clusters) timeCluster(data, cluster, parsed.timecodeScale, trackInfo);
  return parsed;
}

function parseSegment(
  data: Uint8Array,
  segment: ElementHeader,
  parsed: ParsedWebm,
  trackInfo: Map<number, TrackInfo>,
): void {
  const segEnd =
    segment.size === UNKNOWN_SIZE ? data.length : Math.min(segment.dataStart + segment.size, data.length);
  let pos = segment.dataStart;
  while (pos < segEnd) {
    const h = readHeader(data, pos, segEnd);
    // A new EBML header means another stream was appended; it is not part of this one.
    if (!h || h.id === ID.EBML || h.id === ID.Segment) return;
    const unknown = h.size === UNKNOWN_SIZE;
    const declaredEnd = unknown ? segEnd : h.dataStart + h.size;
    const end = Math.min(declaredEnd, segEnd);

    if (h.id === ID.Cluster) {
      const cluster = newCluster();
      const walked = walk(data, h.dataStart, end, unknown, (child, childEnd) =>
        readClusterChild(data, cluster, child, childEnd),
      );
      if (cluster.blocks.length > 0) {
        if (Number.isNaN(cluster.timecode)) throw new Error(`WebM cluster at byte ${pos} has no Timecode`);
        parsed.clusters.push(cluster);
      }
      if (unknown ? walked.truncated : declaredEnd > segEnd) return;
      pos = unknown ? walked.end : declaredEnd;
      continue;
    }

    if (unknown) {
      const walked = walk(data, h.dataStart, end, true, () => {});
      if (walked.truncated) return;
      pos = walked.end;
      continue;
    }
    // Info and Tracks must be complete to be of any use.
    if (declaredEnd > segEnd) return;
    if (h.id === ID.Info) readInfo(data, h.dataStart, end, parsed);
    else if (h.id === ID.Tracks) {
      parsed.tracksData = { start: h.dataStart, end };
      readTracks(data, h.dataStart, end, trackInfo);
    }
    pos = end;
  }
}

function newCluster(): Cluster {
  return { timecode: Number.NaN, keep: [], keepBytes: 0, blocks: [], startMs: 0, endMs: 0 };
}

function readClusterChild(data: Uint8Array, cluster: Cluster, h: ElementHeader, end: number): void {
  if (h.id === ID.Timecode) {
    cluster.timecode = readUint(data, h.dataStart, end);
    return;
  }
  if (CLUSTER_DROP.has(h.id)) return;
  if (h.id === ID.SimpleBlock) {
    const block = readBlock(data, h.dataStart, end, null);
    if (!block) return;
    cluster.blocks.push(block);
  } else if (h.id === ID.BlockGroup) {
    const group: { body: Range | null; durationTicks: number | null } = { body: null, durationTicks: null };
    walk(data, h.dataStart, end, false, (child, childEnd) => {
      if (child.id === ID.Block) group.body = { start: child.dataStart, end: childEnd };
      else if (child.id === ID.BlockDuration) group.durationTicks = readUint(data, child.dataStart, childEnd);
    });
    const block = group.body && readBlock(data, group.body.start, group.body.end, group.durationTicks);
    if (!block) return;
    cluster.blocks.push(block);
  }
  const last = cluster.keep.at(-1);
  if (last && last.end === h.start) last.end = end;
  else cluster.keep.push({ start: h.start, end });
  cluster.keepBytes += end - h.start;
}

function readBlock(data: Uint8Array, start: number, end: number, durationTicks: number | null): BlockRef | null {
  const track = readVint(data, start, end, false);
  if (!track || start + track.length + 3 > end) return null;
  const at = start + track.length;
  const raw = (data[at]! << 8) | data[at + 1]!;
  const rel = raw >= 0x8000 ? raw - 0x10000 : raw;
  const flags = data[at + 2]!;
  return { rel, track: track.value, lacing: (flags >> 1) & 3, frames: at + 3, end, durationTicks };
}

/** Sets the cluster's start and end in whole ms of the original timeline. */
function timeCluster(data: Uint8Array, cluster: Cluster, scale: number, trackInfo: Map<number, TrackInfo>): void {
  let endNs = cluster.timecode * scale;
  for (const block of cluster.blocks) {
    const startNs = (cluster.timecode + block.rel) * scale;
    endNs = Math.max(endNs, startNs + blockDurationNs(data, block, scale, trackInfo.get(block.track)));
  }
  cluster.startMs = Math.round((cluster.timecode * scale) / 1e6);
  cluster.endMs = Math.round(endNs / 1e6);
}

function blockDurationNs(data: Uint8Array, block: BlockRef, scale: number, track: TrackInfo | undefined): number {
  if (block.durationTicks !== null) return block.durationTicks * scale;
  if (block.lacing === 0 && track?.codecId === 'A_OPUS') {
    const ms = opusPacketMs(data, block.frames, block.end);
    if (ms > 0) return ms * 1e6;
  }
  if (track && track.defaultDurationNs > 0) {
    const frames = block.lacing === 0 ? 1 : (data[block.frames] ?? 0) + 1;
    return track.defaultDurationNs * frames;
  }
  return 0;
}

const SILK_FRAME_MS = [10, 20, 40, 60];

/** Packet duration from the Opus TOC byte (RFC 6716 §3.1). */
function opusPacketMs(data: Uint8Array, at: number, end: number): number {
  if (at >= end) return 0;
  const toc = data[at]!;
  const config = toc >> 3;
  // SILK 10/20/40/60 ms, Hybrid 10/20 ms, CELT 2.5/5/10/20 ms.
  const frameMs =
    config < 12 ? (SILK_FRAME_MS[config & 3] ?? 0) : config < 16 ? 10 * 2 ** (config & 1) : 2.5 * 2 ** (config & 3);
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : at + 1 < end ? data[at + 1]! & 0x3f : 0;
  return frameMs * frames;
}

function readInfo(data: Uint8Array, start: number, end: number, parsed: ParsedWebm): void {
  walk(data, start, end, false, (h, childEnd) => {
    if (h.id === ID.TimecodeScale) {
      const scale = readUint(data, h.dataStart, childEnd);
      if (scale > 0) parsed.timecodeScale = scale;
    }
    if (!INFO_DROP.has(h.id)) parsed.infoChildren.push({ start: h.start, end: childEnd });
  });
}

function readTracks(data: Uint8Array, start: number, end: number, tracks: Map<number, TrackInfo>): void {
  walk(data, start, end, false, (entry, entryEnd) => {
    if (entry.id !== ID.TrackEntry) return;
    let number = 0;
    const info: TrackInfo = { codecId: '', defaultDurationNs: 0 };
    walk(data, entry.dataStart, entryEnd, false, (h, childEnd) => {
      if (h.id === ID.TrackNumber) number = readUint(data, h.dataStart, childEnd);
      else if (h.id === ID.CodecID) info.codecId = new TextDecoder().decode(data.subarray(h.dataStart, childEnd));
      else if (h.id === ID.DefaultDuration) info.defaultDurationNs = readUint(data, h.dataStart, childEnd);
    });
    if (number > 0) tracks.set(number, info);
  });
}

/**
 * Visits the complete children of a master element whose data starts at `start`.
 * `end` is the element's end, or for an unknown-size element only an upper bound:
 * it then ends at the first Segment-level element. Stops at a child that is cut off
 * or unreadable (`truncated`); that child is not visited.
 */
function walk(
  data: Uint8Array,
  start: number,
  end: number,
  unknownSize: boolean,
  visit: (h: ElementHeader, end: number) => void,
): { end: number; truncated: boolean } {
  let pos = start;
  while (pos < end) {
    const h = readHeader(data, pos, end);
    if (!h) return { end: pos, truncated: true };
    if (unknownSize && LEVEL1.has(h.id)) return { end: pos, truncated: false };
    if (h.size === UNKNOWN_SIZE || h.dataStart + h.size > end) return { end: pos, truncated: true };
    visit(h, h.dataStart + h.size);
    pos = h.dataStart + h.size;
  }
  return { end, truncated: false };
}

function readHeader(data: Uint8Array, pos: number, end: number): ElementHeader | null {
  const id = readVint(data, pos, end, true);
  if (!id || id.length > 4) return null;
  const size = readVint(data, pos + id.length, end, false);
  if (!size) return null;
  return {
    id: id.value,
    size: size.unknown ? UNKNOWN_SIZE : size.value,
    start: pos,
    dataStart: pos + id.length + size.length,
  };
}

function readVint(
  data: Uint8Array,
  pos: number,
  end: number,
  keepMarker: boolean,
): { value: number; length: number; unknown: boolean } | null {
  if (pos >= end) return null;
  const first = data[pos]!;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || pos + length > end) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let unknown = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    const b = data[pos + i]!;
    value = value * 256 + b;
    if (b !== 0xff) unknown = false;
  }
  return { value, length, unknown };
}

function readUint(data: Uint8Array, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + data[i]!;
  return value;
}
