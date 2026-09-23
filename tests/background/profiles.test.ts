import { beforeEach, describe, expect, it } from 'vitest';
import { starterProfiles } from '@lib/profiles';
import { getResult } from '@lib/storage/resultStore';
import { getSession } from '@lib/storage/sessionStore';
import { sessionId } from '@lib/util/ids';
import type { SessionManager } from '@/entrypoints/background/sessionManager';
import { configure, MEET_CODE, setupHarness, T0, type Harness } from './harness';

const ID = sessionId(MEET_CODE, T0);
const CLIENT = { ...starterProfiles('client-db')[0]!, id: 'client', name: 'Client meeting' };

let h: Harness;
let m: SessionManager;

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

    await m.setProfile(ID, 'client');
    await m.save(ID);
    await m.idle();
    const processes = h.offscreen.callsOf('offscreen/process');
    expect(processes).toHaveLength(2);
    expect(processes[1]?.reuse?.profile?.id).toBe('team');
    expect(processes[1]?.profile.id).toBe('client');
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
