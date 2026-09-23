/**
 * Shared domain contracts. Every context (content, background, offscreen, pages)
 * and every library module codes against these types.
 *
 * Time conventions:
 *  - Epoch timestamps are milliseconds since 1970 (`Date.now()`), named `*At`.
 *  - Meeting-relative times are integer milliseconds from recording start (t = 0 is
 *    the moment MediaRecorder started), named `tStart`/`tEnd` or `start`/`end`.
 */

export type Route = 'team' | 'personal';

// ---------------------------------------------------------------------------
// Captions (content script → background → storage)
// ---------------------------------------------------------------------------

/**
 * One caption block as Meet renders it: one speaker, one run of text. Meet rewrites
 * the text of a block while it refines recognition, so the same `id` is emitted many
 * times with an increasing `rev`. Consumers keep the highest `rev` per `id`.
 */
export interface CaptionSegment {
  /** Stable for the life of the block. Unique within a session. */
  id: string;
  /** Speaker name exactly as Meet displays it ("You"/"Vous" for the local user). */
  speaker: string;
  /** True when Meet labelled the block as the local user. */
  self: boolean;
  /** Latest text of the block. */
  text: string;
  /** ms from recording start when the block first appeared. */
  tStart: number;
  /** ms from recording start of the block's latest text change. */
  tEnd: number;
  /** Revision counter, starts at 0, +1 on every text change. */
  rev: number;
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

export interface TimedWord {
  text: string;
  /** ms from recording start. */
  start: number;
  /** ms from recording start. */
  end: number;
  /** True when the time was interpolated rather than taken from a timestamped word. */
  approx?: boolean;
}

/**
 * `warning` marks a pass that succeeded with degraded output (e.g. a part came back
 * 'incomplete'); the pipeline turns it into a transcript note.
 */
export type PassOutcome = { ok: true; warning?: string } | { ok: false; error: string };

/**
 * Result of transcribing a whole recording. Two Gemini passes run: a timing pass
 * (word timestamps, no custom vocabulary) and a text pass (custom vocabulary, no
 * timestamps). Text-pass words are aligned onto timing-pass times.
 */
export interface TranscriptionResult {
  /** Timed words for the whole recording, sorted by start. Empty if the timing pass failed. */
  words: TimedWord[];
  /** Plain text of the best available pass (text pass preferred). */
  text: string;
  timingPass: PassOutcome;
  textPass: PassOutcome;
  /**
   * Time ranges (ms from recording start) that no successful part covered, e.g. one
   * part failed while the others succeeded. The merge fills them from captions.
   */
  gaps?: { start: number; end: number }[];
}

export interface TranscribeOptions {
  /** Terms to bias recognition toward (team jargon + attendee names). Max 1000. */
  customVocabulary: string[];
  /** BCP-47 hints. Empty = automatic detection with code-switching. */
  languageCodes: string[];
  /** Recording duration if known, used to decide whether to split. */
  durationMs?: number;
  signal?: AbortSignal;
  onProgress?: (stage: JobStage) => void;
}

/** One section of the notes, as written for a meeting. */
export interface SummarySection {
  title: string;
  format: SectionFormat;
  /** Paragraph sections: the text, paragraphs separated by blank lines. '' for bullets. */
  text: string;
  /** Bullet sections: one entry per bullet. [] for paragraphs. */
  items: string[];
}

export interface MeetingSummary {
  /** Short meeting title (≤ 80 chars), in the meeting's main language. */
  title: string;
  /** The profile's sections, in its order, as written for this meeting. */
  sections: SummarySection[];
  actionItems: ActionItem[];
  /** Main language of the meeting as BCP-47 (e.g. "fr-FR"), best effort. */
  language?: string;
}

export interface ActionItem {
  task: string;
  owner?: string;
  due?: string;
}

export interface SummarizeOptions {
  /** Speaker names that appear in the transcript. */
  attendees: string[];
  meetingDate: string;
  /** Whose prompt and sections the notes follow. */
  profile: Pick<Profile, 'prompt' | 'sections'>;
  signal?: AbortSignal;
}

/**
 * Gemini, behind an interface so a backend can replace it later.
 */
export interface MeetingAI {
  transcribe(audio: Blob, opts: TranscribeOptions): Promise<TranscriptionResult>;
  summarize(transcriptText: string, opts: SummarizeOptions): Promise<MeetingSummary>;
}

// ---------------------------------------------------------------------------
// Merged transcript
// ---------------------------------------------------------------------------

export type TranscriptSource = 'audio+captions' | 'audio-only' | 'captions-only';

export interface TranscriptTurn {
  speaker: string;
  /** ms from recording start. */
  start: number;
  /** ms from recording start. */
  end: number;
  text: string;
}

export interface MeetingTranscript {
  turns: TranscriptTurn[];
  source: TranscriptSource;
  /** Human-readable degradation notes ("timing pass failed: …"). Shown on the Notion page. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

export interface ExistingMeeting {
  pageId: string;
  url: string;
  recordedBy: string;
}

export interface MeetingPageInput {
  /** Idempotency key `${meetCode}-${YYYY-MM-DD}`. */
  key: string;
  title: string;
  /** Recording start, epoch ms. */
  startedAt: number;
  durationMs: number;
  attendees: string[];
  meetCode: string;
  recordedBy: string;
  /** Fills the database's optional Profile select, when it has one. */
  profileName?: string;
  source: TranscriptSource;
  summary: MeetingSummary | null;
  transcript: MeetingTranscript;
}

/**
 * Notion, behind an interface so a backend can replace it later.
 * `databaseId` is the id the user pasted into settings for the chosen route.
 */
export interface MeetingStore {
  /** Only complete pages carry the Key (it is written last), so partial saves never match. */
  findByKey(databaseId: string, key: string): Promise<ExistingMeeting | null>;
  createMeeting(databaseId: string, input: MeetingPageInput): Promise<{ pageId: string; url: string }>;
  /**
   * Lists every page carrying `key` (oldest first). Used after create to settle
   * races between two teammates who both recorded the same meeting.
   */
  listByKey(databaseId: string, key: string): Promise<(ExistingMeeting & { createdAt: string })[]>;
  /** Moves a page to Notion's trash (restorable for 30 days). */
  archivePage(pageId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** One person named by Meet's captions in a session, in order of first speech. */
export interface SpeakerInfo {
  /** Display name from the captions; the local user keeps Meet's label with `self`. */
  name: string;
  self: boolean;
  /** ms from recording start of their first and latest caption. */
  firstAt: number;
  lastAt: number;
  /** Total ms covered by their caption blocks (overlaps counted once per block). */
  talkMs: number;
}

export type SessionStatus =
  /** Audio + captions are being captured. */
  | 'recording'
  /** Meeting ended, waiting for the Team | Personal prompt. */
  | 'awaiting-route'
  /** Routed; waiting for Transcribe (auto-transcribe off, or queued). */
  | 'ready'
  /** Pipeline running in the offscreen document. See `stage`. */
  | 'processing'
  /** Transcript + summary stored locally, not yet in Notion. */
  | 'processed'
  | 'saving'
  | 'saved'
  /** Notion already had this meeting; see `notion.recordedBy`. */
  | 'duplicate'
  /** Transcribed, but nothing was said or captured; not saved (would claim the dedupe key). */
  | 'empty'
  | 'failed';

export type JobStage =
  | 'checking-duplicate'
  | 'loading-audio'
  | 'transcribing-timing'
  | 'transcribing-text'
  | 'aligning'
  | 'merging'
  | 'summarizing'
  | 'saving';

export interface SessionMeta {
  /** `${meetCode}_${compact ISO start}`; also the OPFS directory name. */
  id: string;
  meetCode: string;
  /** Meeting title from the Meet UI, when available. */
  meetingTitle?: string;
  /** Recording start (t = 0 for captions and words), epoch ms. */
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: SessionStatus;
  stage?: JobStage;
  route?: Route;
  /**
   * The meeting's profile (a Settings.profiles id), chosen before recording. Meetings from
   * before profiles read their Team | Personal route here (sessionStore normalizes them).
   */
  profileId?: string;
  /**
   * When the default destination applies (the route alarm's time), epoch ms. Set only
   * while that alarm is armed: absent while the routing prompt is paused and once the
   * meeting has a destination.
   */
  routeDeadline?: number;
  /** `${meetCode}-${YYYY-MM-DD}` in local time of `startedAt`. */
  idempotencyKey: string;
  audio: {
    mimeType: string;
    chunkCount: number;
    bytes: number;
    micIncluded: boolean;
    /** Set when capture could not start or died; captions still recorded. */
    error?: string;
    /** Set once retention removed the audio. */
    deletedAt?: number;
    /** Last time a chunk was persisted. Captions don't update it; the recorder watchdog reads it. */
    lastChunkAt?: number;
  };
  captionCount: number;
  /** Speakers seen so far, ordered by first speech; kept current while recording. */
  speakers?: SpeakerInfo[];
  /** Why captions are not being captured (e.g. no content script in the tab). */
  captionsError?: string;
  /** Last time a chunk or caption batch arrived. Used to date orphans. */
  lastHeartbeat?: number;
  /** True when this session was found orphaned at startup. */
  recovered?: boolean;
  error?: string;
  notion?: { pageId: string; url: string; recordedBy?: string };
  savedAt?: number;
  /** Epoch ms after which audio is deleted (savedAt + retention). */
  purgeAudioAt?: number;
  /**
   * Job running in the offscreen document. Its outcome arrives as 'offscreen/job-done'
   * with the same id, so any worker instance can record it.
   */
  job?: {
    id: string;
    kind: 'process' | 'save';
    startedAt: number;
    /** A process job that only summarizes the stored result again (the profile changed). */
    summaryOnly?: boolean;
  };
  /** Transcription attempt number of the last process job (1 = first). */
  attempt?: number;
  /** When an automatic retry after a transient Gemini failure is scheduled, epoch ms. */
  retryAt?: number;
  /**
   * The user chose "Transcribe/Save anyway": the jobs this session runs next (the save
   * after processing, automatic retries, re-runs after a restart) skip the duplicate check.
   */
  forced?: boolean;
}

/** What the pipeline produced for a session; stored locally until saved. */
export interface SessionResult {
  title: string;
  attendees: string[];
  transcript: MeetingTranscript;
  summary: MeetingSummary | null;
  transcription: { timingPass: PassOutcome; textPass: PassOutcome } | null;
  /** The profile the summary was written for. Absent on results from before profiles. */
  profile?: { id: string; name: string };
  createdAt: number;
}

export interface AudioSessionInfo {
  sessionId: string;
  chunkCount: number;
  bytes: number;
}

/**
 * Chunked audio in the Origin Private File System. Chunks are separate files so a
 * crash loses at most the chunk being written.
 */
export interface AudioStore {
  writeChunk(sessionId: string, index: number, data: Blob): Promise<void>;
  /** Concatenates chunks in index order. Null if the session has no chunks. */
  readAudio(sessionId: string): Promise<Blob | null>;
  stat(sessionId: string): Promise<{ chunkCount: number; bytes: number }>;
  list(): Promise<AudioSessionInfo[]>;
  delete(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export type SectionFormat = 'paragraph' | 'bullets';

/** One heading of a profile's notes, which the summary model fills. */
export interface NoteSection {
  /** Stable within its profile (editor rows, import previews). */
  id: string;
  title: string;
  /** What the model writes under the heading. */
  instruction: string;
  format: SectionFormat;
}

/** A kind of meeting: how its notes are written and which Notion database it goes to. */
export interface Profile {
  /** 'team' and 'personal' for the profiles migrated from Team | Personal, else a UUID. */
  id: string;
  name: string;
  /** Notion database link or id, as pasted. */
  databaseId: string;
  /** Context for every summary of this profile ("Sales call with a prospect"). May be empty. */
  prompt: string;
  sections: NoteSection[];
  /** Added to Settings.customVocabulary for this profile's meetings. */
  vocabulary: string[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  geminiApiKey: string;
  notionToken: string;
  notionTeamDbId: string;
  notionPersonalDbId: string;
  defaultRoute: Route;
  autoTranscribe: boolean;
  /** Days to keep audio after the transcript is saved. */
  retentionDays: number;
  /** Your name: fills "Recorded by" and replaces Meet's "You" label. */
  displayName: string;
  customVocabulary: string[];
  languageCodes: string[];
  includeMic: boolean;
  /** Kinds of meeting; always at least one. */
  profiles: Profile[];
  /** Preselected in the popup and used by the keyboard shortcut. */
  defaultProfileId: string;
}

// ---------------------------------------------------------------------------
// Pipeline jobs (background → offscreen)
// ---------------------------------------------------------------------------

export interface ProcessJob {
  meta: SessionMeta;
  captions: CaptionSegment[];
  settings: Settings;
  /** The meeting's profile: its database, vocabulary, prompt and sections. */
  profile: Profile;
  /**
   * Summarize this stored result again for `profile` instead of transcribing: the
   * meeting's profile changed after it was transcribed.
   */
  reuse?: SessionResult;
  /** Skip the Notion duplicate check: the user chose "Transcribe anyway". */
  force?: boolean;
  /** 1 on the first run. Below MAX_TRANSCRIBE_ATTEMPTS a transient Gemini failure returns 'retry-later'. */
  attempt?: number;
}

/** Transient Gemini failures are retried later this many times in total before degrading. */
export const MAX_TRANSCRIBE_ATTEMPTS = 3;

export type ProcessOutcome =
  | { status: 'processed'; result: SessionResult }
  | { status: 'duplicate'; existing: ExistingMeeting }
  /** Gemini was unreachable (network, 408/429/5xx after retries, timeout): try again later instead of degrading. */
  | { status: 'retry-later'; error: string }
  | { status: 'error'; error: string };

export interface SaveJob {
  meta: SessionMeta;
  result: SessionResult;
  settings: Settings;
  /** The meeting's profile: its database, vocabulary, prompt and sections. */
  profile: Profile;
  /** Create the page even if one with this key exists: the user chose "Save anyway". */
  force?: boolean;
}

export type SaveOutcome =
  | { status: 'created'; pageId: string; url: string }
  | { status: 'duplicate'; existing: ExistingMeeting }
  | { status: 'error'; error: string };
