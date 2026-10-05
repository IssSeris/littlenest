import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ListDraft, ListKind } from '../lib/paste-list';
import { usePrivatePasteSession } from './use-private-paste-session';

// activeId is the server's globally unique household membership ID, not a
// household name. A new household membership therefore gets a separate scope.
export const PasteScope = createContext<{ accountId: string; membershipId: string } | null>(null);
type Session = {
  text: string; drafts: ListDraft[]; reviewing: boolean; savedCount: number;
  showErrors: boolean; error: string; uncertainId: string | null; finished: boolean;
};
const empty = (): Session => ({
  text: '', drafts: [], reviewing: false, savedCount: 0, showErrors: false,
  error: '', uncertainId: null, finished: false,
});
const hasDraft = (session: Session) => !session.finished && (!!session.text || session.drafts.length > 0);

function read(raw: string | null): Session {
  if (!raw) return empty();
  const value = JSON.parse(raw);
  if (value.version !== 1) throw new Error('Unsupported draft version');
  const s = value.session;
  if (!s || typeof s.text !== 'string' || !Array.isArray(s.drafts)
    || !['reviewing', 'showErrors', 'finished'].every((field) => typeof s[field] === 'boolean')
    || !Number.isSafeInteger(s.savedCount) || s.savedCount < 0 || typeof s.error !== 'string'
    || !(s.uncertainId === null || typeof s.uncertainId === 'string')
    || !s.drafts.every((row: ListDraft) => row && ['id', 'title', 'quantity', 'assignedTo', 'cadence', 'dueDate'].every((field) => typeof row[field as keyof ListDraft] === 'string')
      && (row.isPaid === undefined || typeof row.isPaid === 'boolean') && (row.payAmount === undefined || typeof row.payAmount === 'string'))
    || new Set(s.drafts.map((row: ListDraft) => row.id)).size !== s.drafts.length
    || (s.uncertainId && !s.drafts.some((row: ListDraft) => row.id === s.uncertainId))) {
    throw new Error('Invalid draft');
  }
  return s;
}

function useBrowserPasteSession(kind: ListKind) {
  const scope = useContext(PasteScope);
  const key = scope ? `little-nest:paste:v1:${JSON.stringify([scope.accountId, scope.membershipId, kind])}` : null;
  const [initial] = useState(() => {
    let raw: string | null = null;
    try {
      raw = key ? window.localStorage.getItem(key) : null;
      return { session: read(raw), raw, error: '' };
    }
    catch { return { session: empty(), raw, error: 'We could not read this browser’s draft. Discard it to start again.' }; }
  });
  const [session, setSession] = useState(initial.session);
  const [storageError, setStorageError] = useState(initial.error);
  const current = useRef(session);
  const revision = useRef(initial.raw);
  const [conflict, setConflict] = useState('');
  const generation = useRef(0);
  const localQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const saving = useRef(false);
  const notify = () => {
    generation.current++;
    if (mounted.current) setConflict('Another tab changed or is saving this draft. Load the latest draft before editing, discarding, or saving.');
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!key) return;
    const check = () => {
      try { if (window.localStorage.getItem(key) !== revision.current) notify(); }
      catch { if (mounted.current) setStorageError('We could not check this browser’s draft. Nothing will be sent until storage is available.'); }
    };
    const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) check(); };
    window.addEventListener('storage', changed);
    window.addEventListener('focus', check);
    return () => {
      window.removeEventListener('storage', changed);
      window.removeEventListener('focus', check);
    };
  }, [key]);

  // All writers use the same origin-wide lock. Revisions also reject a stale
  // tab even when its storage event has not arrived yet.
  const acquire = async (work: () => boolean | Promise<boolean>): Promise<boolean> => {
    if (!key) return work();
    if (!navigator.locks) {
      if (mounted.current) setStorageError('This browser cannot safely coordinate drafts across tabs. Use a browser with Web Locks support. Nothing was sent.');
      return false;
    }
    try {
      return await navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
        if (!lock) { notify(); return false; }
        return work();
      });
    } catch {
      if (mounted.current) setStorageError('We could not coordinate this browser’s draft. Nothing else was sent. Keep this section open and check the saved list before retrying.');
      return false;
    }
  };
  // Queue our own short operations rather than mistaking rapid typing in this
  // tab for another tab holding the lock.
  const coordinated = (work: () => boolean | Promise<boolean>) => {
    const result = localQueue.current.then(() => acquire(work));
    localQueue.current = result;
    return result;
  };
  const write = (change: Partial<Session> | ((previous: Session) => Partial<Session>), publish = true): boolean => {
    try {
      if (key && window.localStorage.getItem(key) !== revision.current) { notify(); return false; }
    } catch {
      if (mounted.current) setStorageError('This browser could not keep your draft. Nothing was sent.');
      return false;
    }
    const next = { ...current.current, ...(typeof change === 'function' ? change(current.current) : change) };
    if (publish) {
      current.current = next;
      if (mounted.current) setSession(next);
    }
    try {
      if (key) {
        // Keep a revisioned empty record after discard/completion to avoid ABA:
        // a tab that originally saw no draft must detect a create/discard cycle.
        const raw = JSON.stringify({ version: 1, revision: crypto.randomUUID(), session: hasDraft(next) ? next : empty() });
        window.localStorage.setItem(key, raw);
        revision.current = raw;
      }
      if (mounted.current) setStorageError('');
      return true;
    } catch {
      if (mounted.current) setStorageError('This browser could not keep your draft. Keep this section open; switching sections or reloading may lose changes.');
      return false;
    }
  };
  const update = (change: Partial<Session> | ((previous: Session) => Partial<Session>)) => {
    if (saving.current) return Promise.resolve(false);
    // Controlled inputs must update synchronously. Each queued persistence
    // operation gets its own snapshot; revision checks still protect storage.
    const next = { ...current.current, ...(typeof change === 'function' ? change(current.current) : change) };
    current.current = next;
    if (mounted.current) setSession(next);
    return coordinated(() => write(next, false));
  };
  const reload = () => coordinated(() => {
    try {
      const raw = key ? window.localStorage.getItem(key) : null;
      const next = read(raw);
      current.current = next; revision.current = raw; generation.current++;
      if (mounted.current) { setSession(next); setConflict(''); setStorageError(''); }
      return true;
    } catch {
      if (mounted.current) setStorageError('We could not read this browser’s draft. Discard it to start again.');
      return false;
    }
  });
  const runSave = async (work: (checkpoint: typeof write) => Promise<void>) => {
    if (saving.current) return false;
    saving.current = true;
    try {
      return await coordinated(async () => {
        if (key && window.localStorage.getItem(key) !== revision.current) { notify(); return false; }
        await work(write); return true;
      });
    } finally { saving.current = false; }
  };
  return { session, update, runSave, reload, conflict, generation, mounted, storageError,
    hasDraft: hasDraft(session) || !!storageError, reset: () => update(empty()) };
}

export function usePasteSession(kind: ListKind) {
  const scope = useContext(PasteScope);
  const browser = useBrowserPasteSession(kind);
  const cloud = usePrivatePasteSession(kind, scope);
  const selected = cloud.active ? { ...browser, ...cloud } : browser;
  return {
    ...selected, synced: cloud.active, cloudAvailable: cloud.available,
    cloudChecking: cloud.checking, cloudPending: cloud.pending,
    cloudTransitioning: cloud.transitioning,
    cloudError: cloud.active ? '' : cloud.storageError,
    startPrivate: () => cloud.activate(false), resumePrivate: () => cloud.activate(true),
    discardPrivate: cloud.reset,
    savePrivateRows: cloud.saveRows,
  };
}