import { useEffect, useState } from 'react';
import { useAuth } from './auth';

/** Whether the signed-in profile is the owner (the owner-only status route answers 200; anyone else gets 404). */
export function useIsOwner(): boolean {
  const { request, profile, demo } = useAuth();
  // The answer is kept per profile, so a sign-out or a switch never shows the last profile's answer.
  const [answer, setAnswer] = useState<{ id: string; owner: boolean } | null>(null);
  const id = demo ? null : profile?.publicId ?? null;
  useEffect(() => {
    if (!id) return;
    let active = true, tries = 0, timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => void request('/v1/owner/research/status').then((response) => {
      if (!active) return;
      if (response.ok) setAnswer({ id, owner: true });
      else if (response.status === 404 || response.status === 401) setAnswer({ id, owner: false });
      else if (++tries < 4) timer = setTimeout(check, 3000);
    }).catch(() => { if (active && ++tries < 4) timer = setTimeout(check, 3000); });
    check();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [id, request]);
  return !!id && answer?.id === id && answer.owner;
}
