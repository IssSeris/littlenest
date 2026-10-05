import { useEffect, useRef, useState } from 'react';
import {
  getNestPasteDraft, putNestPasteDraft, saveNestPasteDraftRow,
  type NestPasteDraft, type NestPasteSession,
} from '@workspace/api-client-react';
import type { ListKind } from '../lib/paste-list';

export const emptyPasteSession = (): NestPasteSession => ({
  text: '', drafts: [], reviewing: false, savedCount: 0, showErrors: false,
  error: '', uncertainId: null, finished: false,
});
type Change = Partial<NestPasteSession> | ((s: NestPasteSession) => Partial<NestPasteSession>);

export function usePrivatePasteSession(kind: ListKind, scope: { accountId: string; membershipId: string } | null) {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const [session, setSession] = useState(emptyPasteSession);
  const current = useRef(session);
  const remote = useRef<NestPasteDraft>({ revision: null, session: null });
  const [available, setAvailable] = useState(false);
  const [checking, setChecking] = useState(true);
  const [pending, setPending] = useState(0);
  const pendingRef = useRef(0);
  const [conflict, setConflict] = useState('');
  const failed = useRef(false);
  const [storageError, setStorageError] = useState('');
  const mounted = useRef(true);
  const generation = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const saving = useRef(false);
  const discarding = useRef(false);
  const [transitioning, setTransitioning] = useState(false);
  const epoch = useRef(0);
  const fetchVersion = useRef(0);
  const invalidateFetch = () => { fetchVersion.current++; };
  const enqueue = (work: () => Promise<boolean>): Promise<boolean> => {
    const started = epoch.current;
    invalidateFetch();
    pendingRef.current++;
    if (mounted.current) setPending((n) => n + 1);
    const result = queue.current.then(() => started === epoch.current ? work() : false);
    queue.current = result.catch(() => undefined);
    return result.finally(() => { pendingRef.current--; if (mounted.current) setPending((n) => n - 1); });
  };
  const apply = (value: NestPasteDraft) => {
    remote.current = value;
    current.current = value.session ?? emptyPasteSession();
    generation.current++;
    failed.current = false;
    if (mounted.current) {
      setSession(current.current); setAvailable(!!value.session && !value.session.finished);
      setConflict(''); setStorageError('');
    }
  };
  const failure = (err: unknown) => {
    failed.current = true; generation.current++;
    if (!mounted.current) return;
    const status = (err as { status?: number }).status;
    setConflict(status === 409
      ? 'Another device changed this private draft. Load the latest draft before continuing; your unsynced edits will be replaced.'
      : 'We could not confirm draft syncing. No more items will be sent. Load the latest draft before continuing; your unsynced edits will be replaced.');
  };
  useEffect(() => {
    mounted.current = true;
    const check = async () => {
      if (!scope) { setChecking(false); return; }
      if (pendingRef.current) return;
      // Do not race our own writes or use a late GET as a false conflict.
      const version = fetchVersion.current;
      try {
        const value = await getNestPasteDraft(scope.membershipId, kind);
        if (!mounted.current || pendingRef.current || version !== fetchVersion.current) return;
        if (activeRef.current) {
          if (value.revision !== remote.current.revision) {
            failed.current = true; generation.current++;
            setConflict('Another device changed this private draft. Load the latest draft before continuing; your unsynced edits will be replaced.');
          }
        } else {
          remote.current = value; setAvailable(!!value.session && !value.session.finished);
        }
        setStorageError('');
      } catch {
        if (mounted.current && version === fetchVersion.current) setStorageError('Private drafts are unavailable. Check your connection and try again.');
      } finally { if (mounted.current) setChecking(false); }
    };
    void check();
    window.addEventListener('focus', check);
    const timer = window.setInterval(check, 15000);
    return () => { mounted.current = false; invalidateFetch(); window.removeEventListener('focus', check); window.clearInterval(timer); };
  }, [scope?.accountId, scope?.membershipId, kind]);

  const reload = () => discarding.current ? Promise.resolve(false) : enqueue(async () => {
    if (!scope) return false;
    try { apply(await getNestPasteDraft(scope.membershipId, kind)); return true; }
    catch { failure(null); return false; }
  });
  const activate = (resume: boolean) => discarding.current ? Promise.resolve(false) : enqueue(async () => {
    if (!scope) return false;
    try {
      const value = await getNestPasteDraft(scope.membershipId, kind);
      if (!resume && value.session && !value.session.finished) {
        remote.current = value; setAvailable(true);
        setStorageError('A private draft already exists. Resume or discard it instead.'); return false;
      }
      const next = resume ? value : await putNestPasteDraft(scope.membershipId, kind, { revision: value.revision, session: emptyPasteSession() });
      activeRef.current = true; setActive(true); apply(next); return true;
    } catch { setStorageError('We could not open your private draft. Try again.'); return false; }
  });
  const persist = async (next: NestPasteSession | null, publish = true) => {
    if (!scope || failed.current) return false;
    try {
      const value = await putNestPasteDraft(scope.membershipId, kind, { revision: remote.current.revision, session: next });
      remote.current = value;
      if (publish) apply(value);
      else if (mounted.current) setStorageError('');
      return true;
    } catch (err) { failure(err); return false; }
  };
  const update = (change: Change) => {
    // The synchronous fence also rejects handlers captured before the panel
    // closes; a delayed discard must never be followed by an old-session edit.
    if (!activeRef.current || discarding.current || saving.current || failed.current) return Promise.resolve(false);
    const started = epoch.current;
    const next = { ...current.current, ...(typeof change === 'function' ? change(current.current) : change) };
    current.current = next; setSession(next);
    return enqueue(() => started === epoch.current && activeRef.current && !discarding.current
      ? persist(next, false) : Promise.resolve(false));
  };
  const reset = () => {
    if (discarding.current || saving.current) return Promise.resolve(false);
    discarding.current = true;
    epoch.current++;
    setTransitioning(true);
    return enqueue(async () => {
      try {
        if (!await persist(null)) {
          if (!activeRef.current) setStorageError('We could not discard the private draft. Resume it and load the latest version before discarding.');
          return false;
        }
        // Invalidate all old-session work before switching the UI back to
        // browser mode. Only explicit activation can start a new session.
        epoch.current++;
        activeRef.current = false; setActive(false); setAvailable(false); return true;
      } finally {
        discarding.current = false;
        if (mounted.current) setTransitioning(false);
      }
    });
  };
  const saveRows = (ids: string[]) => {
    if (!scope || !activeRef.current || discarding.current || saving.current || failed.current) return Promise.resolve(false);
    saving.current = true;
    const started = epoch.current;
    return enqueue(async () => {
      if (!activeRef.current || discarding.current || started !== epoch.current || failed.current) return false;
      for (const rowId of ids) {
        if (!mounted.current || started !== epoch.current || failed.current || current.current.uncertainId) return false;
        // Persist uncertainty before sending. A crash before the next request
        // requires a new saved-list review, never a blind retry.
        if (!await persist({ ...current.current, uncertainId: rowId, error: '' })) return false;
        if (!mounted.current) return false;
        try {
          apply(await saveNestPasteDraftRow(scope.membershipId, kind, { revision: remote.current.revision!, rowId }));
        } catch (err) {
          // A known validation rejection made no record. Other failures may
          // have committed: retain uncertainty and require a fresh reload.
          if ((err as { status?: number }).status === 400) {
            await persist({ ...current.current, uncertainId: null, showErrors: true, error: 'Fix this reviewed row before saving.' });
          } else failure(err);
          return false;
        }
      }
      return true;
    }).finally(() => { saving.current = false; });
  };
  return {
    active, available, checking, pending: pending > 0, transitioning, activate,
    session, update, reload, reset, saveRows, conflict, generation, mounted, storageError,
    hasDraft: !!session.text || session.drafts.length > 0,
  };
}