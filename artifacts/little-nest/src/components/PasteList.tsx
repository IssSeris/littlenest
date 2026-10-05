import { useEffect, useRef, useState } from 'react';
import { ClipboardList, Plus, RefreshCw, X } from 'lucide-react';
import type { AppData } from '../App';
import { usePasteSession } from '../hooks/use-paste-session';
import {
  cadences, localToday, parseList, validateDraft,
  type ListDraft, type ListKind, type ListRefresher, type ListSaver,
} from '../lib/paste-list';

type Props = { kind: ListKind; data: AppData; onSave: ListSaver; onRefresh: ListRefresher };

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

export default function PasteList({ kind, data, onSave, onRefresh }: Props) {
  const { session, update, runSave, reload, conflict, generation, mounted, storageError, hasDraft, reset: resetSession,
    synced, cloudAvailable, cloudChecking, cloudPending, cloudTransitioning, cloudError, startPrivate, resumePrivate, discardPrivate, savePrivateRows } = usePasteSession(kind);
  const [open, setOpen] = useState(false);
  const { text, drafts, reviewing, savedCount, showErrors, error, uncertainId, finished } = session;
  const setText = (text: string) => update({ text });
  const setDrafts = (value: ListDraft[] | ((rows: ListDraft[]) => ListDraft[])) => update((s) => ({ drafts: typeof value === 'function' ? value(s.drafts) : value }));
  const setError = (error: string) => update({ error });
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState<AppData | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const savingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const firstTitleRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  const noun = kind === 'groceries' ? 'grocery' : 'chore';

  useEffect(() => { if (open && !reviewing) inputRef.current?.focus(); }, [open, reviewing]);
  useEffect(() => { if (reviewing) firstTitleRef.current?.focus(); }, [reviewing]);
  useEffect(() => { if (!open && restoreFocus.current) { restoreFocus.current = false; triggerRef.current?.focus(); } }, [open]);

  const members = data.members;
  const memberName = (id: string) => members.find((m) => m.id === id)?.name ?? 'Household';

  const reset = async () => {
    if (!await resetSession()) return false;
    setRefreshed(null); setRefreshError(''); return true;
  };
  const cancel = async () => {
    if (savingRef.current || refreshing) return;
    if ((text.trim() || drafts.length) && !finished && !window.confirm(uncertainId
      ? 'Discard the remaining drafts? The uncertain item may already be saved. Check the household list before pasting it again. Items already saved stay saved.'
      : 'Discard this draft? Items already saved stay saved.')) return;
    if (await reset()) { restoreFocus.current = true; setOpen(false); }
  };

  const review = () => {
    const titles = parseList(text);
    if (!titles.length) { setError('Paste at least one line to review.'); return; }
    return update({ error: '', drafts: titles.map((title) => ({ id: newId(), title, quantity: '', assignedTo: 'household', cadence: 'Once', dueDate: localToday(), isPaid: false, payAmount: '' })),
      reviewing: true, finished: false });
  };

  const patch = (id: string, change: Partial<ListDraft>) => setDrafts((rows) => rows.map((r) => r.id === id ? { ...r, ...change } : r));
  const removeDraft = (id: string) => setDrafts((rows) => rows.filter((r) => r.id !== id));
  const errorsFor = (row: ListDraft) => validateDraft(kind, row, members);
  const errorRows = drafts.filter((r) => errorsFor(r).length);

  const submit = async () => {
    if (savingRef.current || uncertainId || conflict) return;
    savingRef.current = true; setSaving(true);
    try {
      if (synced) {
        if (!await update({ showErrors: true, error: '' })) return;
        if (errorRows.length) { await update({ error: `Fix ${errorRows.length} items before adding.` }); return; }
        await savePrivateRows(drafts.map((r) => r.id));
        // Synced saves use the server's atomic record/draft endpoint instead
        // of the browser-local saver. Refresh the visible household list.
        await onRefresh();
        return;
      }
      await runSave(async (checkpoint) => {
        if (!checkpoint({ showErrors: true, error: '' })) {
          checkpoint({ error: 'Nothing was sent. Browser draft storage is unavailable.' }); return;
        }
        if (errorRows.length) { checkpoint({ error: `Fix ${errorRows.length} ${errorRows.length === 1 ? 'item' : 'items'} before adding.` }); return; }
        const queue = [...drafts];
        for (const row of queue) {
          if (!mounted.current) return;
          // A reload while awaiting the server must resume as uncertain, not as
          // an ordinary retry. Do not send if that safety checkpoint cannot save.
          if (!checkpoint({ uncertainId: row.id })) {
            checkpoint({ uncertainId: null, error: 'Nothing was sent. Browser draft storage is unavailable.' });
            return;
          }
          let result;
          try { result = await onSave(kind, row); } catch { result = { status: 'uncertain' as const }; }
          if (result.status === 'saved') {
            const kept = checkpoint((s) => ({ savedCount: s.savedCount + 1, drafts: s.drafts.filter((r) => r.id !== row.id), uncertainId: null,
              finished: s.drafts.length === 1 }));
            if (!kept || !mounted.current) return;
            continue;
          }
          if (result.status === 'blocked') {
            checkpoint({ uncertainId: null, error: result.error || 'We could not save this item. Your drafts are still here.' });
          } else {
            if (mounted.current) { setRefreshed(null); setRefreshError(''); }
            checkpoint({ error: result.error || 'We did not get a clear answer for this item. It may or may not have saved.' });
          }
          return;
        }
        checkpoint({ finished: true, error: '' });
      });
    } finally {
      savingRef.current = false; if (mounted.current) setSaving(false);
    }
  };

  const refresh = async () => {
    if (savingRef.current || refreshing || conflict) return;
    const started = generation.current;
    setRefreshing(true); setRefreshError(''); setRefreshed(null);
    try {
      const next = await onRefresh();
      if (!mounted.current || generation.current !== started) return;
      if (next) setRefreshed(next); else setRefreshError('We could not check your saved list. Try again before deciding.');
    } catch { setRefreshError('We could not check your saved list. Try again before deciding.'); }
    finally { setRefreshing(false); }
  };

  const resolveSaved = async () => {
    if (!uncertainId || !refreshed || conflict) return;
    await update((s) => ({ drafts: s.drafts.filter((r) => r.id !== uncertainId), savedCount: s.savedCount + 1,
      uncertainId: null, error: '', finished: s.drafts.length === 1 }));
    setRefreshed(null);
  };
  const resolveRetry = async () => {
    if (!refreshed || conflict) return;
    await update({ uncertainId: null, error: '' }); setRefreshed(null);
  };
  useEffect(() => { if (conflict) { setRefreshed(null); setRefreshError(''); } }, [conflict, session]);
  const crossTabNotice = conflict && <div role="alert" data-testid="paste-conflict">
    <p>{conflict}</p>
    <button type="button" className="button button-soft" disabled={saving || refreshing || cloudPending} data-testid="paste-load-latest"
      onClick={async () => { setRefreshed(null); setRefreshError(''); await reload(); }}>Load latest draft</button>
  </div>;
  const privateChoice = !synced && <div data-testid="paste-private-options">
    <p className="paste-hint">Private synced drafts are only visible to your signed-in account, not other household members. Browser drafts are never uploaded automatically.</p>
    {cloudError && <p role="alert">{cloudError}</p>}
    {cloudChecking ? <p role="status">Checking for a private draft…</p> : cloudAvailable ? <>
      <p className="paste-hint">You have an unfinished private {noun} draft available across your devices.</p>
      {hasDraft && <p className="paste-hint">Finish or discard this browser’s draft before resuming your private draft.</p>}
      <button type="button" className="button button-soft" disabled={hasDraft || saving || cloudPending}
        data-testid="paste-private-resume" onClick={async () => {
          if (await resumePrivate()) { setRefreshed(null); setRefreshError(''); setOpen(true); }
        }}>Resume private draft</button>
      <button type="button" className="button button-soft" disabled={saving || cloudPending}
        data-testid="paste-private-discard" onClick={async () => {
          if (window.confirm('Discard your private draft on all devices? An uncertain item may already be saved. Check the saved list before pasting again. Items already saved stay saved.')) await discardPrivate();
        }}>Discard private draft</button>
    </> : <button type="button" className="button button-soft" disabled={hasDraft || saving || cloudPending}
      data-testid="paste-private-start" onClick={async () => {
        if (await startPrivate()) { setRefreshed(null); setRefreshError(''); setOpen(true); }
      }}>Start a private synced list</button>}
    {cloudError && <button type="button" className="button button-soft" disabled={cloudPending}
      onClick={() => void resumePrivate()}>Check private draft again</button>}
  </div>;

  if (!open) {
    return (
      <div className="paste-list">
        {hasDraft && <p className="paste-hint" data-testid="paste-draft-notice">You have an unfinished {noun} list {synced ? 'in your private synced draft' : 'in this browser'}.</p>}
        {storageError && <p role="alert">{storageError}</p>}
        {crossTabNotice}
        <button ref={triggerRef} type="button" className="button paste-trigger" aria-expanded={false} aria-controls="paste-panel" onClick={() => setOpen(true)} data-testid={hasDraft ? 'paste-resume' : 'paste-open'}>
          <ClipboardList size={15} /> {hasDraft ? 'Resume draft' : 'Paste a list'}
        </button>
        {hasDraft && <button type="button" className="button button-soft" onClick={cancel} data-testid="paste-discard">Discard</button>}
        {privateChoice}
      </div>
    );
  }

  const uncertainRow = drafts.find((r) => r.id === uncertainId);
  const savedRecords = refreshed ? (kind === 'groceries' ? refreshed.groceries : refreshed.chores) : [];
  const locked = saving || refreshing || cloudTransitioning || !!conflict;

  return (
    <div className="paste-list">
      <section id="paste-panel" className="surface paste-panel" aria-labelledby="paste-heading" data-testid="paste-panel"
        onKeyDown={(e) => { if (e.key === 'Escape' && !saving && !uncertainId) { e.stopPropagation(); cancel(); } }}>
        <div>
          <h2 id="paste-heading">Paste a list</h2>
          <p className="paste-hint">One {noun} per line. Bullets and numbers are tidied for you. You will review everything before anything is saved.</p>
          <p className="paste-hint">{synced
            ? 'This draft syncs privately across your devices for your account and household. Other members cannot see it. Up to 20,000 characters and 200 rows. Discard removes it on all devices; saved items stay saved.'
            : 'Unfinished drafts stay in this browser for your account and household. Discard them on shared devices when you are done.'}</p>
          {synced && <p role="status" data-testid="paste-sync-status">{cloudPending ? 'Syncing private draft…' : conflict ? 'Private draft needs attention.' : 'Private draft synced.'}</p>}
          {storageError && <p role="alert" data-testid="paste-storage-error">{storageError}</p>}
          {crossTabNotice}
          {privateChoice}
        </div>

        {!reviewing && (
          <>
            <div>
              <label className="field-label" htmlFor="paste-input">Your list</label>
              <textarea id="paste-input" disabled={locked} ref={inputRef} className="textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'groceries' ? 'Oat milk\nBananas\nPasta' : 'Unload dishwasher\nWater the plants'} data-testid="paste-input" />
            </div>
            <div className="paste-actions">
              <button type="button" className="button button-primary" disabled={locked} onClick={review} data-testid="paste-review-button">Review items</button>
              <button type="button" className="button button-soft" onClick={cancel} data-testid="paste-cancel">Cancel</button>
            </div>
          </>
        )}

        {reviewing && (
          <div data-testid="paste-review">
            {drafts.length > 0 && (
              <ul className="paste-rows" aria-label="Items to add">
                {drafts.map((row, index) => {
                  const errs = showErrors ? errorsFor(row) : [];
                  const isUnc = row.id === uncertainId;
                  const off = locked || isUnc;
                  return (
                    <li key={row.id}>
                      <fieldset className={`paste-row ${errs.length ? 'has-error' : ''} ${isUnc ? 'is-uncertain' : ''}`} disabled={off} data-testid={`paste-row-${row.id}`}>
                        <legend>Item {index + 1}{isUnc ? ' — needs a check' : ''}</legend>
                        <div className="paste-row-top">
                          <div>
                            <label className="field-label" htmlFor={`paste-title-${row.id}`}>Name</label>
                            <input id={`paste-title-${row.id}`} ref={index === 0 ? firstTitleRef : undefined} className="field" value={row.title} onChange={(e) => patch(row.id, { title: e.target.value })} aria-invalid={errs.length > 0} data-testid={`paste-title-${row.id}`} />
                          </div>
                          <button type="button" className="icon-btn" onClick={() => removeDraft(row.id)} aria-label={`Remove ${row.title || `item ${index + 1}`}`} data-testid={`paste-remove-${row.id}`}><X size={15} /></button>
                        </div>
                        <div className={`paste-row-grid ${kind}`} style={{ marginTop: 10 }}>
                          {kind === 'groceries' ? (
                            <div>
                              <label className="field-label" htmlFor={`paste-quantity-${row.id}`}>Quantity (optional)</label>
                              <input id={`paste-quantity-${row.id}`} className="field" value={row.quantity} onChange={(e) => patch(row.id, { quantity: e.target.value })} placeholder="2 cartons" data-testid={`paste-quantity-${row.id}`} />
                            </div>
                          ) : (
                            <>
                              <div>
                                <label className="field-label" htmlFor={`paste-assignee-${row.id}`}>Assigned to</label>
                                <select id={`paste-assignee-${row.id}`} className="select" value={row.assignedTo} onChange={(e) => patch(row.id, { assignedTo: e.target.value })} data-testid={`paste-assignee-${row.id}`}>
                                  <option value="household">Household</option>
                                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                                </select>
                              </div>
                              <div>
                                <label className="field-label" htmlFor={`paste-cadence-${row.id}`}>Repeats</label>
                                <select id={`paste-cadence-${row.id}`} className="select" value={row.cadence} onChange={(e) => patch(row.id, { cadence: e.target.value })} data-testid={`paste-cadence-${row.id}`}>
                                  {cadences.map((c) => <option key={c} value={c}>{c}</option>)}
                                </select>
                              </div>
                              <div>
                                <label className="field-label" htmlFor={`paste-date-${row.id}`}>Due date</label>
                                <input id={`paste-date-${row.id}`} type="date" className="field" value={row.dueDate} onChange={(e) => patch(row.id, { dueDate: e.target.value })} data-testid={`paste-date-${row.id}`} />
                              </div>
                              <div><label className="field-label" htmlFor={`paste-paid-${row.id}`}>Paid chore</label><input id={`paste-paid-${row.id}`} type="checkbox" checked={Boolean(row.isPaid)} onChange={(e) => patch(row.id, { isPaid: e.target.checked })} data-testid={`paste-paid-${row.id}`} /></div>
                              {row.isPaid && <div><label className="field-label" htmlFor={`paste-pay-amount-${row.id}`}>Earned amount</label><input id={`paste-pay-amount-${row.id}`} className="field" type="number" inputMode="decimal" min="0.01" max="10000000" step="0.01" value={row.payAmount ?? ''} onChange={(e) => patch(row.id, { payAmount: e.target.value })} data-testid={`paste-pay-amount-${row.id}`} /></div>}
                            </>
                          )}
                        </div>
                        {errs.length > 0 && <ul className="paste-err" role="alert">{errs.map((m) => <li key={m}>{m}</li>)}</ul>}
                      </fieldset>
                    </li>
                  );
                })}
              </ul>
            )}

            {uncertainRow && (
              <div className="paste-check" style={{ marginTop: 12 }} data-testid="paste-uncertain">
                <strong>Check “{uncertainRow.title}” before retrying</strong>
                <p className="paste-hint">The answer for this item was unclear, and it can still have saved. Looking at your saved list first avoids adding it twice. Items with the same name are not matched for you — compare the details yourself.</p>
                <div className="paste-actions">
                  <button type="button" className="button button-soft" onClick={refresh} disabled={refreshing || locked} data-testid="paste-refresh"><RefreshCw size={14} /> {refreshing ? 'Checking…' : refreshed ? 'Check again' : 'Check saved list'}</button>
                </div>
                {refreshError && <p className="paste-status is-error" role="alert" data-testid="paste-refresh-error">{refreshError}</p>}
                {refreshed && (
                  <>
                    <ul aria-label={`Saved ${noun} records`} data-testid="paste-saved-list">
                      {savedRecords.length === 0 && <li>Nothing is saved in this list yet.</li>}
                      {kind === 'groceries'
                        ? refreshed.groceries.map((g) => <li key={g.id}>{g.title}<span>{g.quantity ? `Quantity: ${g.quantity}` : 'No quantity'}</span></li>)
                        : refreshed.chores.map((c) => <li key={c.id}>{c.title}<span>{memberName(c.assignedTo)} · {c.cadence} · due {c.dueDate}</span></li>)}
                    </ul>
                    <div className="paste-actions">
                      <button type="button" className="button button-primary" onClick={resolveSaved} data-testid="paste-resolve-saved">Already saved — remove draft</button>
                      <button type="button" className="button button-soft" onClick={resolveRetry} data-testid="paste-resolve-retry">Not saved — retry this draft</button>
                    </div>
                  </>
                )}
              </div>
            )}

            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              <div className={`paste-status ${error ? 'is-error' : finished ? '' : 'is-warn'}`} role="status" aria-live="polite" data-testid="paste-status">
                {error
                  ? `${error} ${savedCount} saved, ${drafts.length} remaining.`
                  : finished && !drafts.length
                    ? `All done. ${savedCount} saved, 0 remaining.`
                    : saving ? `Saving… ${savedCount} saved, ${drafts.length} remaining.`
                    : showErrors && errorRows.length ? `${errorRows.length} to fix. ${savedCount} saved, ${drafts.length} remaining.`
                    : `${savedCount} saved, ${drafts.length} remaining.`}
              </div>
              <div className="paste-actions">
                {drafts.length > 0 && (
                  <button type="button" className="button button-primary" onClick={submit} disabled={locked || !!uncertainId || cloudPending} data-testid="paste-add">
                    <Plus size={15} /> Add items ({drafts.length})
                  </button>
                )}
                <button type="button" className="button button-soft" onClick={cancel} disabled={locked} data-testid="paste-cancel">{finished && !drafts.length ? 'Done' : 'Cancel'}</button>
              </div>
            </div>
          </div>
        )}

        {!reviewing && error && <p className="paste-status is-error" role="alert" data-testid="paste-status">{error}</p>}
      </section>
    </div>
  );
}
