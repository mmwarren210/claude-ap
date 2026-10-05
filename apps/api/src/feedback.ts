import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Beta feedback (owner, 2026-10-05): testers report bugs and suggestions in the app. Twice a day they're reviewed:
// each is planned, fixed or declined with a short reply, and the fixes go out as patch notes everyone can read.

export type FeedbackKind = 'BUG' | 'SUGGESTION';
export type FeedbackStatus = 'NEW' | 'PLANNED' | 'FIXED' | 'DECLINED';
export interface FeedbackItem {
  readonly id: string; readonly kind: FeedbackKind; readonly text: string; readonly screen: string | null;
  readonly accountId: string; readonly username: string; readonly createdAt: string;
  status: FeedbackStatus; reply: string | null; updatedAt: string; updateId: string | null;
}
export interface PatchNote {
  readonly id: string; readonly title: string; readonly body: string; readonly createdAt: string;
  /** The reports this update answers. */
  readonly feedbackIds: readonly string[];
}
interface Saved { items: FeedbackItem[]; updates: PatchNote[] }

/** Reports per tester in any 24 hours, so one person can't flood the list. */
export const DAILY_REPORTS = 15;

export class FeedbackStore {
  private data: Saved | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string | null, private readonly clock: () => Date = () => new Date()) {}

  private async load(): Promise<Saved> {
    if (this.data) return this.data;
    let saved: Saved = { items: [], updates: [] };
    if (this.file) try { saved = JSON.parse(await readFile(this.file, 'utf8')) as Saved; } catch { /* first run */ }
    this.data = { items: saved.items ?? [], updates: saved.updates ?? [] };
    return this.data;
  }
  private async save() {
    if (!this.file || !this.data) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data), { mode: 0o600 });
    await rename(temporary, this.file);
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task); this.chain = result.catch(() => undefined); return result;
  }

  /** Saves a tester's report. Throws DAILY_LIMIT after DAILY_REPORTS in 24 hours. */
  submit(account: { accountId: string; username: string }, kind: FeedbackKind, text: string, screen: string | null) {
    return this.exclusive(async () => {
      const data = await this.load(), now = this.clock();
      const recent = data.items.filter((item) => item.accountId === account.accountId &&
        Date.parse(item.createdAt) > now.getTime() - 86_400_000).length;
      if (recent >= DAILY_REPORTS) throw new Error('DAILY_LIMIT');
      const item: FeedbackItem = { id: randomUUID(), kind, text: text.trim(), screen: screen?.trim() || null,
        accountId: account.accountId, username: account.username, createdAt: now.toISOString(), status: 'NEW', reply: null,
        updatedAt: now.toISOString(), updateId: null };
      data.items.push(item);
      await this.save();
      return item;
    });
  }

  /** One tester's own reports, newest first (no account ids). */
  async mine(accountId: string) {
    const data = await this.load();
    return data.items.filter((item) => item.accountId === accountId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ accountId: _account, ...item }) => item);
  }

  /** Every report for review: new ones first, then newest. */
  async all() {
    const data = await this.load();
    const rank = (item: FeedbackItem) => item.status === 'NEW' ? 0 : item.status === 'PLANNED' ? 1 : 2;
    return [...data.items].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt))
      .map(({ accountId: _account, ...item }) => item);
  }

  /** Marks a report planned, fixed or declined, with an optional reply the tester sees. */
  review(id: string, status: FeedbackStatus, reply: string | null) {
    return this.exclusive(async () => {
      const data = await this.load(), item = data.items.find((entry) => entry.id === id);
      if (!item) throw new Error('FEEDBACK_NOT_FOUND');
      item.status = status; item.reply = reply?.trim() || item.reply; item.updatedAt = this.clock().toISOString();
      await this.save();
      const { accountId: _account, ...shown } = item;
      return shown;
    });
  }

  /** Posts patch notes; the reports it names are marked fixed and linked to it. */
  postUpdate(title: string, body: string, feedbackIds: readonly string[] = []) {
    return this.exclusive(async () => {
      const data = await this.load(), now = this.clock().toISOString();
      const known = feedbackIds.filter((id) => data.items.some((item) => item.id === id));
      const note: PatchNote = { id: randomUUID(), title: title.trim(), body: body.trim(), createdAt: now, feedbackIds: known };
      data.updates.push(note);
      for (const item of data.items) if (known.includes(item.id)) {
        item.status = 'FIXED'; item.updateId = note.id; item.updatedAt = now;
      }
      await this.save();
      return note;
    });
  }

  /** Patch notes, newest first. */
  async updates(limit = 30) {
    const data = await this.load();
    return [...data.updates].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  /** Counts for the review: how many reports wait, by kind. */
  async summary() {
    const data = await this.load();
    const open = data.items.filter((item) => item.status === 'NEW');
    return { new: open.length, bugs: open.filter((item) => item.kind === 'BUG').length,
      suggestions: open.filter((item) => item.kind === 'SUGGESTION').length, total: data.items.length,
      updates: data.updates.length };
  }
}
