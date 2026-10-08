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

export class SecretUnlocks {
  private accounts: Set<string> | null = null;
  private loading: Promise<Set<string>> | null = null;
  constructor(private readonly file: string | null) {}

  private load(): Promise<Set<string>> {
    if (this.accounts) return Promise.resolve(this.accounts);
    this.loading ??= (async () => {
      const saved = this.file ? await readFile(this.file, 'utf8').then((body) => JSON.parse(body) as { accounts?: string[] }).catch(() => null) : null;
      return this.accounts = new Set(saved?.accounts ?? []);
    })();
    return this.loading;
  }

  async has(accountId: string): Promise<boolean> { return (await this.load()).has(accountId); }

  async add(accountId: string): Promise<void> {
    const accounts = await this.load();
    if (accounts.has(accountId)) return;
    accounts.add(accountId);
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify({ accounts: [...accounts] }));
    await rename(temporary, this.file);
  }
}
