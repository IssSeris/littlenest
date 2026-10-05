import { useState } from 'react';
import type { AppData } from '../App';
import type { DataSetter } from '../hooks/use-nest';
import type { NestJournalReply as Reply } from '@workspace/api-client-react';
import './journal-replies.css';

type Props = { entryId: string; data: AppData; setData: DataSetter; memberName: (id: string) => string };
const MAX = 5000;
const fmt = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
};

export default function JournalReplies({ entryId, data, setData, memberName }: Props) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const entry = data.journal.find((e) => e.id === entryId);
  if (!entry) return null;
  if (!entry.shared) {
    return <div className="jr" data-testid={`replies-paused-${entryId}`}><p className="jr-paused">Replies are paused until this entry is shared. If it is shared again, the earlier conversation will come back.</p></div>;
  }
  const all = data.journalReplies;
  const replies = all.filter((r) => r.entryId === entryId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const check = (text: string) => {
    const t = text.trim();
    if (!t) return 'Write something first.';
    if (t.length > MAX) return `Please keep replies to ${MAX} characters or fewer.`;
    return '';
  };
  const add = async () => {
    const msg = check(draft);
    setError(msg);
    if (msg) return;
    const reply: Reply = { id: crypto.randomUUID(), entryId, body: draft.trim(), authorId: data.activeId, createdAt: new Date().toISOString() };
    const ok = await setData((old) => ({ ...old, journalReplies: [...old.journalReplies, reply] }));
    if (ok) setDraft('');
  };
  const save = async (r: Reply) => {
    const msg = check(editDraft);
    setEditError(msg);
    if (msg) return;
    if (!all.some((x) => x.id === r.id)) { setEditError('This reply was removed.'); return; }
    const body = editDraft.trim();
    const ok = await setData((old) => {
      return { ...old, journalReplies: old.journalReplies.map((x) => x.id === r.id ? { ...x, body } : x) };
    });
    if (ok) { setEditId(null); setEditDraft(''); }
  };
  const del = async (r: Reply) => {
    const ok = await setData((old) => {
      return { ...old, journalReplies: old.journalReplies.filter((x) => x.id !== r.id) };
    });
    if (ok) setConfirmId(null);
  };

  return (
    <div className="jr" data-testid={`replies-${entryId}`}>
      <h3 className="jr-title">Replies</h3>
      {replies.length === 0 && <p className="jr-empty" data-testid={`replies-empty-${entryId}`}>No replies yet.</p>}
      {replies.length > 0 && <ul className="jr-list" aria-label="Replies">{replies.map((r) => {
        const mine = r.authorId === data.activeId;
        const editing = editId === r.id;
        return (
          <li className="jr-item" key={r.id} data-testid={`reply-${r.id}`}>
            <div className="jr-meta"><strong data-testid={`reply-author-${r.id}`}>{memberName(r.authorId)}</strong><span data-testid={`reply-date-${r.id}`}>{fmt(r.createdAt)}</span></div>
            {editing ? <>
              <textarea className="textarea" maxLength={MAX} value={editDraft} onChange={(e) => setEditDraft(e.target.value)} aria-label="Edit your reply" data-testid={`input-edit-reply-${r.id}`} />
              {editError && <p className="jr-error" role="alert" data-testid={`error-edit-reply-${r.id}`}>{editError}</p>}
              <div className="jr-form-actions">
                <button type="button" className="button button-primary" onClick={() => void save(r)} aria-label="Save reply changes" data-testid={`button-save-reply-${r.id}`}>Save</button>
                <button type="button" className="button button-soft" onClick={() => { setEditId(null); setEditError(''); }} aria-label="Cancel editing reply" data-testid={`button-cancel-edit-reply-${r.id}`}>Cancel</button>
                <span className="jr-count">{editDraft.trim().length}/{MAX}</span>
              </div>
            </> : <>
              <p className="jr-body" data-testid={`text-reply-body-${r.id}`}>{r.body}</p>
              {mine && <div className="jr-actions">
                {confirmId === r.id ? <>
                  <span className="jr-confirm">Delete this reply for good?</span>
                  <button type="button" className="button button-danger" onClick={() => void del(r)} aria-label="Confirm delete reply" data-testid={`button-confirm-delete-reply-${r.id}`}>Yes, delete</button>
                  <button type="button" className="button button-soft" onClick={() => setConfirmId(null)} aria-label="Keep reply" data-testid={`button-keep-reply-${r.id}`}>Keep</button>
                </> : <>
                  <button type="button" className="button button-soft" onClick={() => { setEditId(r.id); setEditDraft(r.body); setEditError(''); setConfirmId(null); }} aria-label="Edit your reply" data-testid={`button-edit-reply-${r.id}`}>Edit</button>
                  <button type="button" className="button button-danger" onClick={() => setConfirmId(r.id)} aria-label="Delete your reply" data-testid={`button-delete-reply-${r.id}`}>Delete</button>
                </>}
              </div>}
            </>}
          </li>
        );
      })}</ul>}
      <form onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <p className="jr-empty">Replies are visible to both people while this entry is shared.</p>
        <textarea className="textarea" maxLength={MAX} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a reply" aria-label="Write a reply" data-testid={`input-reply-${entryId}`} />
        {error && <p className="jr-error" role="alert" data-testid={`error-reply-${entryId}`}>{error}</p>}
        <div className="jr-form-actions">
          <button type="submit" className="button button-primary" aria-label="Send reply" data-testid={`button-send-reply-${entryId}`}>Reply</button>
          <span className="jr-count">{draft.trim().length}/{MAX}</span>
        </div>
      </form>
    </div>
  );
}
