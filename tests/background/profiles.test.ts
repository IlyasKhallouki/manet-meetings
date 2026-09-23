import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { problems } from '@/entrypoints/background/copy';
import { starterProfiles } from '@lib/profiles';
import { getSettings } from '@lib/settings';
import { getResult, putResult } from '@lib/storage/resultStore';
import { getSession, putSession } from '@lib/storage/sessionStore';
import type { SaveOutcome, SessionMeta, SessionResult, Settings } from '@lib/types';
import { idempotencyKey, sessionId } from '@lib/util/ids';
import type { SessionManager } from '@/entrypoints/background/sessionManager';
import { configure, MEET_CODE, setupHarness, T0, type Harness } from './harness';

const ID = sessionId(MEET_CODE, T0);
const HOUR = 60 * 60 * 1000;
const CLIENT = { ...starterProfiles('client-db')[0]!, id: 'client', name: 'Client meeting' };
const CREATED: SaveOutcome = { status: 'created', pageId: 'page-1', url: 'https://www.notion.so/page-1' };

/** A meeting as an earlier worker left it in storage. */
function stored(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: ID,
    meetCode: MEET_CODE,
    startedAt: T0,
    endedAt: T0 + HOUR,
    durationMs: HOUR,
    status: 'processed',
    idempotencyKey: idempotencyKey(MEET_CODE, T0),
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 12, bytes: 48_000, micIncluded: true },
    captionCount: 3,
    ...patch,
  };
}

/** A transcript stored before profiles: nothing says which profile its notes follow. */
const LEGACY: SessionResult = {
  title: 'Sync',
  attendees: ['Alice'],
  transcript: { turns: [{ speaker: 'Alice', start: 0, end: 4000, text: 'Bonjour' }], source: 'audio+captions', notes: [] },
  summary: null,
  transcription: { timingPass: { ok: true }, textPass: { ok: true } },
  createdAt: T0,
};

let h: Harness;
let m: SessionManager;

/**
 * A new worker whose settings reads can be interrupted: after arm(n, between), the nth read
 * first runs `between`, i.e. something the person does while a request is halfway through.
 */
async function interruptibleManager() {
  let pending: { n: number; between: () => Promise<unknown> } | null = null;
  const manager = h.createManager({
    getSettings: async () => {
      if (pending && --pending.n === 0) {
        const { between } = pending;
        pending = null;
        await between();
      }
      return getSettings();
    },
  });
  await manager.boot();
  return {
    manager,
    arm(n: number, between: () => Promise<unknown>) {
      pending = { n, between };
    },
  };
}

beforeEach(async () => {
  h = setupHarness();
  // Auto-transcribe off: each test starts the jobs itself, so a profile change never meets a running job.
  await configure({ profiles: [...starterProfiles('team-db', 'personal-db'), CLIENT], defaultProfileId: 'team', autoTranscribe: false });
  m = h.createManager();
  await m.boot();
});

describe('profiles', () => {
  it('records for the profile chosen in the popup, or the default', async () => {
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'client');
    expect((await getSession(ID))?.profileId).toBe('client');
  });

  it('falls back to the default profile for an unknown id', async () => {
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'gone');
    expect((await getSession(ID))?.profileId).toBe('team');
  });

  it('sends the profile with the jobs and saves to its database', async () => {
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'client');
    await m.stop(ID);
    await m.route(ID, 'team'); // routing window, until Task 10 removes it
    await m.setProfile(ID, 'client');
    await m.transcribe(ID);
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process')[0]?.profile.id).toBe('client');
    expect(h.offscreen.callsOf('offscreen/save')[0]?.profile.databaseId).toBe('client-db');
  });

  it('summarizes again, without transcribing, when the profile changed after transcription', async () => {
    h.offscreen.save = () => ({ status: 'error', error: 'Notion is busy right now. Try again in a minute.' });
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'team');
    await m.stop(ID);
    await m.route(ID, 'team');
    await m.transcribe(ID);
    await m.idle(); // processed with Team, save failed
    expect((await getResult(ID))?.profile?.id).toBe('team');

    h.offscreen.save = () => CREATED;
    await m.setProfile(ID, 'client');
    await m.save(ID);
    await m.idle();
    const processes = h.offscreen.callsOf('offscreen/process');
    expect(processes).toHaveLength(2);
    expect(processes[1]?.reuse?.profile?.id).toBe('team');
    expect(processes[1]?.profile.id).toBe('client');
    // The save follows, to the new profile's database, with the notes written for it.
    expect(h.offscreen.callsOf('offscreen/save').at(-1)?.profile.databaseId).toBe('client-db');
    expect((await getResult(ID))?.profile).toEqual({ id: 'client', name: 'Client meeting' });
    expect((await getSession(ID))?.status).toBe('saved');
  });

  it('keeps “Save a second copy” through the notes written again for the new profile', async () => {
    h.offscreen.save = () => ({
      status: 'duplicate',
      existing: { pageId: 'p0', url: 'https://www.notion.so/p0', recordedBy: 'Marie' },
    });
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'team');
    await m.stop(ID);
    await m.route(ID, 'team');
    await m.transcribe(ID);
    await m.idle();
    expect((await getSession(ID))?.status).toBe('duplicate');

    h.offscreen.save = () => CREATED;
    await m.setProfile(ID, 'client');
    await m.save(ID, { force: true });
    await m.idle();
    const processes = h.offscreen.callsOf('offscreen/process');
    expect(processes).toHaveLength(2);
    expect(processes[1]).toMatchObject({ force: true, profile: { id: 'client' }, reuse: { profile: { id: 'team' } } });
    expect(h.offscreen.callsOf('offscreen/save').at(-1)).toMatchObject({ force: true, profile: { databaseId: 'client-db' } });
    expect((await getSession(ID))?.status).toBe('saved');
  });

  it.each([
    ['whose profile was deleted', { profiles: starterProfiles('team-db', 'personal-db') }, problems.profileDeleted],
    ['whose settings lost the Notion token', { notionToken: '' }, problems.missingSettings(['a Notion token'])],
  ] as [string, Partial<Settings>, string][])(
    'forgets a scheduled retry for a meeting %s, so restarts don’t tell again',
    async (_what, patch, error) => {
      const create = vi.spyOn(fakeBrowser.notifications, 'create');
      await putSession(
        stored({
          status: 'failed',
          route: 'team',
          profileId: 'client',
          attempt: 1,
          retryAt: T0 + HOUR,
          error: problems.geminiRetrying('Gemini API error 503', T0 + HOUR),
        }),
      );
      await configure({ profiles: [...starterProfiles('team-db', 'personal-db'), CLIENT], autoTranscribe: false, ...patch });
      h.clock.set(T0 + HOUR);
      await m.onAlarm(`retry:${ID}`);
      await m.idle();
      // Two worker restarts later, the meeting still waits for the person, told once.
      for (let restart = 0; restart < 2; restart++) {
        const next = h.createManager();
        await next.boot();
        await next.idle();
      }
      expect(create).toHaveBeenCalledTimes(1);
      const meta = await getSession(ID);
      expect(meta).toMatchObject({ status: 'failed', error });
      expect(meta?.retryAt).toBeUndefined();
      expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
    },
  );

  it('summarizes a result from before profiles again when the profile changes', async () => {
    // Stored before profiles: the route is the meeting's profile, the result says none.
    await putSession(stored({ route: 'team' }));
    await putResult(ID, LEGACY);
    await m.setProfile(ID, 'personal');
    await m.save(ID);
    await m.idle();
    const processes = h.offscreen.callsOf('offscreen/process');
    expect(processes).toHaveLength(1);
    expect(processes[0]?.reuse?.profile).toEqual({ id: 'team', name: 'Team' });
    expect(processes[0]?.profile.id).toBe('personal');
    expect(h.offscreen.callsOf('offscreen/save').at(-1)?.profile.databaseId).toBe('personal-db');
  });

  it('summarizes a result from before profiles again when the routing window changes its destination', async () => {
    await putSession(stored({ route: 'team', profileId: 'team' }));
    await putResult(ID, LEGACY);
    await m.route(ID, 'personal');
    await m.save(ID);
    await m.idle();
    const processes = h.offscreen.callsOf('offscreen/process');
    expect(processes).toHaveLength(1);
    expect(processes[0]?.reuse?.profile?.id).toBe('team');
    expect(processes[0]?.profile.id).toBe('personal');
  });

  it('does not save for a profile that changed while the save was starting', async () => {
    h.offscreen.save = () => ({ status: 'error', error: 'Notion is busy right now. Try again in a minute.' });
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'team');
    await m.stop(ID);
    await m.route(ID, 'team');
    await m.transcribe(ID);
    await m.idle(); // processed with Team, save failed
    h.offscreen.save = () => CREATED;

    const { manager, arm } = await interruptibleManager();
    // Save reads the meeting (Team), then the settings: the profile changes in between.
    arm(1, () => manager.setProfile(ID, 'client'));
    await manager.save(ID);
    await manager.idle();
    expect(h.offscreen.callsOf('offscreen/save')).toHaveLength(1);
    expect(await getSession(ID)).toMatchObject({ status: 'failed', profileId: 'client' });

    // The next Save writes the notes for Client, then files them there.
    await manager.save(ID);
    await manager.idle();
    expect(h.offscreen.callsOf('offscreen/process').at(-1)?.profile.id).toBe('client');
    expect(h.offscreen.callsOf('offscreen/save').at(-1)?.profile.databaseId).toBe('client-db');
    expect((await getSession(ID))?.status).toBe('saved');
  });

  it('does not bring back the transcript of a meeting deleted while its profile changed', async () => {
    await putSession(stored({ route: 'team' }));
    await putResult(ID, LEGACY);
    const { manager, arm } = await interruptibleManager();
    // The change checks the profile, reads the old result, then looks up its name: the delete lands there.
    arm(2, () => manager.remove(ID));
    await expect(manager.setProfile(ID, 'personal')).rejects.toThrow('This meeting was deleted.');
    expect(await getSession(ID)).toBeNull();
    expect(await getResult(ID)).toBeNull();
  });

  it('saves a result from before profiles as it is when the profile stays', async () => {
    await putSession(stored({ route: 'personal' }));
    await putResult(ID, LEGACY);
    await m.save(ID);
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
    expect(h.offscreen.callsOf('offscreen/save').at(-1)?.profile.databaseId).toBe('personal-db');
  });

  it('asks for another profile when the meeting’s was deleted', async () => {
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'client');
    await m.stop(ID);
    await m.route(ID, 'personal');
    await m.setProfile(ID, 'client');
    await configure({ profiles: starterProfiles('team-db', 'personal-db') });
    await m.transcribe(ID);
    expect(await getSession(ID)).toMatchObject({ status: 'failed', error: 'This meeting’s profile was deleted. Choose another profile.' });
  });

  it('refuses an unknown profile and a meeting on its way to Notion', async () => {
    const tabId = await h.openMeetTab();
    await m.start(tabId);
    await expect(m.setProfile(ID, 'gone')).rejects.toThrow('That profile no longer exists. Reload the page and choose another.');
    await m.stop(ID);
    await m.route(ID, 'team');
    await m.transcribe(ID);
    await m.idle();
    expect((await getSession(ID))?.status).toBe('saved');
    await expect(m.setProfile(ID, 'client')).rejects.toThrow('This meeting is already in Notion.');
    expect((await getSession(ID))?.profileId).toBe('team');
  });
});
