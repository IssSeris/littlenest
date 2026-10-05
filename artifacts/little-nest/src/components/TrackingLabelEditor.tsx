import { useEffect, useState, type FormEvent } from 'react';
import { Pencil } from 'lucide-react';
import type { AppData } from '../App';
import type { DataSetter } from '../hooks/use-nest';

type Member = AppData['members'][number];

export default function TrackingLabelEditor({ member, setData }: { member: Member; setData: DataSetter }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(member.trackingLabel ?? 'School & work');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!editing) setDraft(member.trackingLabel ?? 'School & work');
  }, [member.trackingLabel, member.id, editing]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const label = draft.trim();
    if (!label) { setError('Give your tracking space a name.'); return; }
    setBusy(true);
    setError('');
    const saved = await setData((old) => ({
      ...old,
      members: old.members.map((row) => row.id === member.id ? { ...row, trackingLabel: label } : row),
    }));
    setBusy(false);
    if (saved) setEditing(false);
    else setError('Could not save this name. Your input has been kept; check the save notice and try again.');
  };

  if (!editing) return <button type="button" className="button button-soft" style={{ marginBottom: 12 }} onClick={() => setEditing(true)} data-testid={`button-customize-tracking-${member.id}`} aria-label={`Customize ${member.name}'s school or work tracking`}><Pencil size={13} /> Customize tracking</button>;
  return <form onSubmit={(event) => void save(event)} style={{ marginBottom: 16 }} data-testid={`form-tracking-${member.id}`}>
    <label className="field-wrap">
      <span className="field-label">What is {member.name} tracking?</span>
      <input className="field" value={draft} onChange={(event) => setDraft(event.target.value)} required maxLength={80} disabled={busy} autoFocus placeholder="College, work projects, training…" data-testid={`input-tracking-label-${member.id}`} />
    </label>
    <p className="list-meta">Choose any name that fits now. You can change it later without losing tasks or goals.</p>
    {error && <p role="alert">{error}</p>}
    <div className="toolbar"><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save name'}</button><button type="button" className="button button-soft" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>Cancel</button></div>
  </form>;
}