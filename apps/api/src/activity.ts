import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Time on the app per member (owner, 2026-10-08): while a signed-in member has the app open and on screen, it sends one
// beat a minute with the tab in view. Each beat at least 50 seconds after the last counts one minute, by Eastern date and
// by tab; the owner sees the totals in More › Member activity. Nothing else is recorded.

interface Member { username: string | null; lastSeen: string; days: Record<string, number>; tabs: Record<string, number> }
type Saved = { members: Record<string, Member> };

export interface MemberActivity {
  readonly accountId: string; readonly username: string | null; readonly lastSeen: string;
  readonly todayMinutes: number; readonly weekMinutes: number; readonly totalMinutes: number;
  readonly topTabs: readonly { tab: string; minutes: number }[];
}

const easternDay = (time: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(time);

export class ActivityLog {
  private data: Saved | null = null;
  private loading: Promise<Saved> | null = null;
  private dirty = false;
  private lastBeat = new Map<string, number>();
  constructor(private readonly file: string | null, private readonly clock: () => Date = () => new Date()) {}

  private load(): Promise<Saved> {
    if (this.data) return Promise.resolve(this.data);
    this.loading ??= (async () => {
      const saved = this.file ? await readFile(this.file, 'utf8').then((body) => JSON.parse(body) as Saved).catch(() => null) : null;
      return this.data = { members: saved?.members ?? {} };
    })();
    return this.loading;
  }

  /** One beat from a member's open app; counts a minute unless the last one was under 50 seconds ago. */
  async beat(accountId: string, username: string | null, tab: string | null): Promise<boolean> {
    const data = await this.load(), now = this.clock(), time = now.getTime();
    if (time - (this.lastBeat.get(accountId) ?? 0) < 50_000) return false;
    this.lastBeat.set(accountId, time);
    const member = data.members[accountId] ??= { username, lastSeen: now.toISOString(), days: {}, tabs: {} };
    member.username = username ?? member.username;
    member.lastSeen = now.toISOString();
    const day = easternDay(now);
    member.days[day] = (member.days[day] ?? 0) + 1;
    const name = (tab ?? 'other').slice(0, 40);
    member.tabs[name] = (member.tabs[name] ?? 0) + 1;
    this.dirty = true;
    return true;
  }

  /** Writes when something changed (the server calls it every few minutes, so a beat costs no disk write). */
  async flush(): Promise<void> {
    if (!this.dirty || !this.file || !this.data) return;
    this.dirty = false;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data));
    await rename(temporary, this.file);
  }

  /** Every member's minutes today, over the last 7 days and in all, most recently seen first. */
  async report(): Promise<MemberActivity[]> {
    const data = await this.load(), now = this.clock();
    const today = easternDay(now);
    const week = new Set(Array.from({ length: 7 }, (_, index) => easternDay(new Date(now.getTime() - index * 86_400_000))));
    return Object.entries(data.members).map(([accountId, member]) => ({
      accountId, username: member.username, lastSeen: member.lastSeen,
      todayMinutes: member.days[today] ?? 0,
      weekMinutes: Object.entries(member.days).filter(([day]) => week.has(day)).reduce((sum, [, minutes]) => sum + minutes, 0),
      totalMinutes: Object.values(member.days).reduce((sum, minutes) => sum + minutes, 0),
      topTabs: Object.entries(member.tabs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tab, minutes]) => ({ tab, minutes })),
    })).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }
}
