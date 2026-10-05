import { useCallback, useEffect, useRef, useState } from 'react';
import type { NestJournalAttachment } from '@workspace/api-client-react';
import { FileText, Paperclip, RotateCw, X } from 'lucide-react';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip';
const ALLOWED = new Set(ACCEPT.split(',').map((x) => x.slice(1)));
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const url = (id: string, download = false) => `/api/nest/attachments/${encodeURIComponent(id)}${download ? '/download' : ''}`;
const sizeLabel = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const isImage = (a: NestJournalAttachment) => INLINE.has(a.contentType);

export function JournalAttachmentList({ attachments }: { attachments?: NestJournalAttachment[] }) {
  if (!attachments?.length) return null;
  return <div className="attach-list" data-testid="list-journal-attachments">{attachments.map((a) => isImage(a)
    ? <a key={a.id} className="attach-thumb" href={url(a.id)} target="_blank" rel="noopener noreferrer" title={a.name}><img src={url(a.id)} alt={a.name} loading="lazy" /></a>
    : <a key={a.id} className="attach-doc" href={url(a.id, true)} download={a.name}><FileText size={15} /><span>{a.name}</span><small>{sizeLabel(a.size)}</small></a>)}</div>;
}

type Upload = { key: string; file: File; error?: string };

export default function JournalAttachments({ initial, onBusyChange, onPendingChange }: { initial?: NestJournalAttachment[]; onBusyChange: (busy: boolean) => void; onPendingChange: (pending: boolean) => void }) {
  const [items, setItems] = useState<NestJournalAttachment[]>(initial ?? []);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [drag, setDrag] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const running = useRef(new Set<string>());
  const busyRef = useRef(onBusyChange);
  busyRef.current = onBusyChange;
  const added = useRef(new Set<string>());

  useEffect(() => { alive.current = true; return () => {
    alive.current = false;
    for (const id of added.current) void fetch(url(id), { method: 'DELETE', credentials: 'include' }).catch(() => undefined);
  }; }, []);
  useEffect(() => { onPendingChange(uploads.length > 0); }, [uploads.length, onPendingChange]);

  const start = useCallback(async (u: Upload) => {
    if (running.current.has(u.key)) return;
    if (itemsRef.current.length + running.current.size >= MAX_FILES) {
      setUploads((l) => l.map((x) => x.key === u.key ? { ...x, error: `Only ${MAX_FILES} attachments fit in one entry.` } : x));
      return;
    }
    running.current.add(u.key);
    busyRef.current(true);
    setUploads((l) => l.map((x) => x.key === u.key ? { ...x, error: undefined } : x));
    let error = '';
    try {
      const res = await fetch(`/api/nest/attachments?name=${encodeURIComponent(u.file.name)}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/octet-stream' }, body: u.file });
      const body = await res.json().catch(() => null);
      if (!res.ok) error = (body as { error?: string } | null)?.error ?? 'Upload failed. Please try again.';
      else if (alive.current) { added.current.add((body as NestJournalAttachment).id); setItems((l) => [...l, body as NestJournalAttachment]); }
      else if (body?.id) void fetch(url(body.id), { method: 'DELETE', credentials: 'include' }).catch(() => undefined);
    } catch { error = 'The connection failed. Please try again.'; }
    running.current.delete(u.key);
    if (!alive.current) return;
    setUploads((l) => error ? l.map((x) => x.key === u.key ? { ...x, error } : x) : l.filter((x) => x.key !== u.key));
    if (!running.current.size) busyRef.current(false);
  }, []);

  const addFiles = useCallback((files: File[]) => {
    let room = MAX_FILES - itemsRef.current.length - running.current.size;
    const next: Upload[] = [];
    const errs: Upload[] = [];
    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (room <= 0) { errs.push({ key, file, error: `Only ${MAX_FILES} attachments fit in one entry.` }); continue; }
      if (file.size > MAX_BYTES) { errs.push({ key, file, error: 'This file is over 10 MB.' }); continue; }
      if (file.size === 0) { errs.push({ key, file, error: 'This file is empty.' }); continue; }
      if (!ALLOWED.has(ext)) { errs.push({ key, file, error: 'This file type is not supported.' }); continue; }
      room--; next.push({ key, file });
    }
    setUploads((l) => [...l, ...next, ...errs]);
    next.forEach((u) => void start(u));
  }, [start]);

  useEffect(() => {
    const form = root.current?.closest('form');
    if (!form) return;
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      const files = Array.from(data.items).filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));
      if (!files.length) return;
      if (!data.getData('text/plain')) e.preventDefault();
      addFiles(files.map((f, i) => f.name && f.name !== 'image.png' ? f : new File([f], `pasted-image-${Date.now()}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
    };
    form.addEventListener('paste', onPaste);
    return () => form.removeEventListener('paste', onPaste);
  }, [addFiles]);

  useEffect(() => {
    const body = root.current?.closest('form')?.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
    if (body) body.required = items.length === 0;
  }, [items.length]);

  const remove = (a: NestJournalAttachment) => {
    setItems((l) => l.filter((x) => x.id !== a.id));
    if (added.current.has(a.id)) {
      added.current.delete(a.id);
      void fetch(url(a.id), { method: 'DELETE', credentials: 'include' }).catch(() => undefined);
    }
  };
  const busy = uploads.some((u) => !u.error);
  const full = items.length + uploads.length >= MAX_FILES;

  return <div className={`attach-editor ${drag ? 'drag' : ''}`} ref={root}
    onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
    onDragLeave={() => setDrag(false)}
    onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(Array.from(e.dataTransfer.files)); }}>
    {items.map((a) => <input type="hidden" name="attachmentIds" value={a.id} key={a.id} />)}
    <input type="hidden" name="attachmentsMeta" value={JSON.stringify(items)} />
    <div className="attach-head">
      <button type="button" className="button button-soft" onClick={() => input.current?.click()} disabled={busy || full} data-testid="button-attach-file"><Paperclip size={13} /> Add photos or files</button>
      <span className="attach-hint">Paste an image, or drop files here. Up to 10 files, 10 MB each.</span>
    </div>
    <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
    {(items.length > 0 || uploads.length > 0) && <ul className="attach-edit-list" aria-live="polite">
      {items.map((a) => <li key={a.id} className="attach-row">
        {isImage(a) ? <img src={url(a.id)} alt="" /> : <span className="attach-icon"><FileText size={16} /></span>}
        <span className="attach-name">{a.name}<small>{sizeLabel(a.size)}</small></span>
        <button type="button" className="icon-btn" onClick={() => remove(a)} disabled={busy} aria-label={`Remove ${a.name}`}><X size={14} /></button>
      </li>)}
      {uploads.map((u) => <li key={u.key} className={`attach-row ${u.error ? 'failed' : 'loading'}`} role={u.error ? 'alert' : undefined}>
        <span className="attach-icon"><FileText size={16} /></span>
        <span className="attach-name">{u.file.name}<small>{u.error ?? 'Uploading…'}</small></span>
        {u.error && <>
          {!u.error.startsWith('Only') && !u.error.includes('over 10') && !u.error.includes('supported') && !u.error.includes('empty') && <button type="button" className="icon-btn" onClick={() => void start(u)} aria-label={`Retry ${u.file.name}`}><RotateCw size={14} /></button>}
          <button type="button" className="icon-btn" onClick={() => setUploads((l) => l.filter((x) => x.key !== u.key))} aria-label="Dismiss"><X size={14} /></button>
        </>}
        {!u.error && <span className="attach-bar" />}
      </li>)}
    </ul>}
  </div>;
}
