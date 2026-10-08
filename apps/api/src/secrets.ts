import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// "Secrets" (More tab, owner's idea 2026-10-08): a password, set on the server as CROWNIQ_SECRETS_PASSWORD and never in the
// code, unlocks GKR+ for the account that enters it. Unlocked accounts are saved so the unlock survives restarts.

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Whether a typed password matches, compared in constant time; false when no password is set. */
export function passwordMatches(typed: string, password: string | null): boolean {
  if (!password) return false;
  return timingSafeEqual(digest(typed), digest(password));
}

/** One account that unlocked GKR+, with its username then (for the owner's list). */
export interface SecretUnlock { readonly accountId: string; readonly username: string | null; readonly unlockedAt: string }

export class SecretUnlocks {
  private accounts: Map<string, SecretUnlock> | null = null;
  private loading: Promise<Map<string, SecretUnlock>> | null = null;
  constructor(private readonly file: string | null, private readonly clock: () => Date = () => new Date()) {}

  private load(): Promise<Map<string, SecretUnlock>> {
    if (this.accounts) return Promise.resolve(this.accounts);
    this.loading ??= (async () => {
      const saved = this.file ? await readFile(this.file, 'utf8')
        .then((body) => JSON.parse(body) as { accounts?: (string | SecretUnlock)[] }).catch(() => null) : null;
      // The first version saved bare account ids.
      const rows = (saved?.accounts ?? []).map((item) => typeof item === 'string' ? { accountId: item, username: null, unlockedAt: '' } : item);
      return this.accounts = new Map(rows.map((row) => [row.accountId, row]));
    })();
    return this.loading;
  }

  private async save(accounts: Map<string, SecretUnlock>) {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify({ accounts: [...accounts.values()] }));
    await rename(temporary, this.file);
  }

  async has(accountId: string): Promise<boolean> { return (await this.load()).has(accountId); }

  async list(): Promise<SecretUnlock[]> {
    return [...(await this.load()).values()].sort((a, b) => b.unlockedAt.localeCompare(a.unlockedAt));
  }

  async add(accountId: string, username: string | null = null): Promise<void> {
    const accounts = await this.load();
    if (accounts.has(accountId)) return;
    accounts.set(accountId, { accountId, username, unlockedAt: this.clock().toISOString() });
    await this.save(accounts);
  }

  /** Removes an account's unlock; false when it had none. */
  async remove(accountId: string): Promise<boolean> {
    const accounts = await this.load();
    if (!accounts.delete(accountId)) return false;
    await this.save(accounts);
    return true;
  }
}
