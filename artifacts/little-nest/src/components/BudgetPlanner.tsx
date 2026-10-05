import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Form as FormProvider } from './ui/form';
import { ChevronLeft, ChevronRight, Copy, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  budgetMonthLabel, categorySuggestions, currentBudgetMonth, formatMoney, normalizeCategory,
  shiftBudgetMonth, summarizeBudget, type BudgetDraft, type BudgetPlan, type MoneyEntry,
} from '../lib/budget';
import './budget-planner.css';

type Props = {
  plans: BudgetPlan[];
  entries: MoneyEntry[];
  onSave: (draft: BudgetDraft, existingId?: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onAddMoney: (category: string | undefined, month: string) => void;
};
type Line = { key: number; category: string; amount: string; note: string };
type Form = { month: string; income: string; savings: string; note: string; lines: Line[] };

const MAX = 10000000;
let keySeed = 1;
const parseAmt = (v: string) => (v.trim() === '' || !/^\d*\.?\d{0,2}$/.test(v.trim()) ? NaN : Number(v));
const toForm = (plan: BudgetPlan | undefined, month: string): Form => ({
  month,
  income: plan ? String(plan.incomeTarget) : '',
  savings: plan ? String(plan.savingsTarget) : '0',
  note: plan?.note ?? '',
  lines: (plan?.categories ?? []).map((c) => ({ key: keySeed++, category: c.category, amount: String(c.amount), note: c.note ?? '' })),
});

function validate(f: Form) {
  const errors: Record<string, string> = {};
  const inc = parseAmt(f.income); const sav = parseAmt(f.savings);
  if (!(inc >= 0 && inc <= MAX)) errors.income = 'Enter an amount from 0 to 10,000,000 (up to 2 decimals).';
  if (!(sav >= 0 && sav <= MAX)) errors.savings = 'Enter an amount from 0 to 10,000,000 (up to 2 decimals).';
  if (f.note.length > 400) errors.note = 'Plan note can be at most 400 characters.';
  if (f.lines.length > 100) errors.lines = 'A plan can have at most 100 categories.';
  const seen = new Set<string>();
  for (const l of f.lines) {
    const name = l.category.trim().replace(/\s+/g, ' ');
    const amt = parseAmt(l.amount);
    if (!name) errors[`name-${l.key}`] = 'Name this category.';
    else if (name.length > 100) errors[`name-${l.key}`] = 'Category can be at most 100 characters.';
    else if (seen.has(normalizeCategory(name))) errors[`name-${l.key}`] = 'This category is already in the plan.';
    seen.add(normalizeCategory(name));
    if (!(amt > 0 && amt <= MAX)) errors[`amt-${l.key}`] = 'Cap must be above 0 and at most 10,000,000.';
    if (l.note.length > 160) errors[`note-${l.key}`] = 'Note can be at most 160 characters.';
  }
  return errors;
}

function BudgetPlanner({ plans, entries, onSave, onDelete, onAddMoney }: Props) {
  const [month, setMonth] = useState(currentBudgetMonth());
  const editor = useForm<Form>({ defaultValues: toForm(undefined, month) });
  const [editorOpen, setEditorOpen] = useState(false);
  const values = editor.watch();
  const form = editorOpen ? values : null;
  const [editingId, setEditingId] = useState<string | undefined>();
  const [dirty, setDirty] = useState(false);
  const [pendingMonth, setPendingMonth] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const plan = plans.find((p) => p.month === month);
  const prevPlan = plans.find((p) => p.month === shiftBudgetMonth(month, -1));
  const summary = useMemo(() => summarizeBudget(entries, month, plan), [entries, month, plan]);
  const errors = useMemo(() => (form ? validate(form) : {}), [form]);

  const suggestions = useMemo(() => {
    const seen = new Set<string>(); const out: string[] = [];
    for (const e of entries) if (e.kind === 'expense' && e.category.trim()) {
      const k = normalizeCategory(e.category);
      if (!seen.has(k)) { seen.add(k); out.push(e.category.trim()); }
    }
    for (const c of categorySuggestions) if (!seen.has(normalizeCategory(c))) { seen.add(normalizeCategory(c)); out.push(c); }
    return out;
  }, [entries]);

  const open = (f: Form, id?: string, isDirty = false) => { editor.reset(f); setEditorOpen(true); setEditingId(id); setDirty(isDirty); setShowErrors(false); setFailed(false); setConfirmDelete(false); };
  const close = () => { setEditorOpen(false); setEditingId(undefined); setDirty(false); setPendingMonth(null); setShowErrors(false); setFailed(false); };
  const update = (patch: Partial<Form>) => {
    if (patch.income !== undefined) editor.setValue('income', patch.income, { shouldDirty: true });
    if (patch.savings !== undefined) editor.setValue('savings', patch.savings, { shouldDirty: true });
    if (patch.note !== undefined) editor.setValue('note', patch.note, { shouldDirty: true });
    if (patch.lines !== undefined) editor.setValue('lines', patch.lines, { shouldDirty: true });
    setDirty(true);
  };
  const updateLine = (key: number, patch: Partial<Line>) => { editor.setValue('lines', editor.getValues('lines').map((line) => line.key === key ? { ...line, ...patch } : line), { shouldDirty: true }); setDirty(true); };
  const addLine = (category = '') => {
    if (!form) return;
    update({ lines: [...form.lines, { key: keySeed++, category, amount: '', note: '' }] });
  };

  const goMonth = (target: string) => {
    if (form && dirty) { setPendingMonth(target); return; }
    if (form) close();
    setMonth(target); setConfirmDelete(false);
  };
  const discardAndGo = () => { if (pendingMonth) { const m = pendingMonth; close(); setMonth(m); } };

  const submit = async () => {
    if (!form) return;
    setShowErrors(true);
    if (Object.keys(errors).length) return;
    const draft: BudgetDraft = {
      month: form.month,
      incomeTarget: Number(form.income),
      savingsTarget: Number(form.savings),
      note: form.note.trim(),
      categories: form.lines.map((l) => {
        const note = l.note.trim();
        const c = { category: l.category.trim().replace(/\s+/g, ' '), amount: Number(l.amount) };
        return note ? { ...c, note } : c;
      }),
    };
    setBusy(true); setFailed(false);
    let ok = false;
    try { ok = await onSave(draft, editingId); } catch { ok = false; }
    setBusy(false);
    if (ok) { close(); setMonth(draft.month); } else setFailed(true);
  };

  const remove = async () => {
    if (!plan) return;
    setBusy(true); setDeleteFailed(false);
    let ok = false;
    try { ok = await onDelete(plan.id); } catch { ok = false; }
    setBusy(false);
    if (ok) setConfirmDelete(false); else setDeleteFailed(true);
  };

  const copyPrev = () => {
    if (!prevPlan) return;
    const f = toForm(prevPlan, month);
    open(f, undefined, true);
  };

  const err = (k: string) => (showErrors && errors[k] ? <div className="bp-err" role="alert" data-testid={`error-budget-${k}`}>{errors[k]}</div> : null);
  const incomeTarget = plan?.incomeTarget ?? 0;
  const draftAssigned = form ? form.lines.reduce((s, l) => s + (parseAmt(l.amount) || 0), 0) : 0;
  const draftUnassigned = form ? (parseAmt(form.income) || 0) - draftAssigned - (parseAmt(form.savings) || 0) : 0;
  const usedNames = new Set(form?.lines.map((l) => normalizeCategory(l.category)) ?? []);

  return (
    <section className="bp" aria-label="Monthly budget plan" data-testid="section-budget-planner">
      <div className="bp-head">
        <h2>Monthly plan</h2>
        <div className="bp-nav">
          <button className="icon-btn" onClick={() => goMonth(shiftBudgetMonth(month, -1))} aria-label="Previous month" data-testid="button-budget-prev"><ChevronLeft size={18} /></button>
          <span className="bp-month" aria-live="polite" data-testid="text-budget-month">{budgetMonthLabel(month)}</span>
          <button className="icon-btn" onClick={() => goMonth(shiftBudgetMonth(month, 1))} aria-label="Next month" data-testid="button-budget-next"><ChevronRight size={18} /></button>
          {month !== currentBudgetMonth() && <button className="button button-soft" onClick={() => goMonth(currentBudgetMonth())} data-testid="button-budget-today">This month</button>}
        </div>
      </div>
      <div className="bp-note" data-testid="text-budget-disclaimer">Plans are manual. Logged money notes are compared against your caps. Net is what is left from logged income, not money actually saved. Savings target is a planned set-aside only. This is not financial advice and no bank is connected.</div>

      {pendingMonth && (
        <div className="bp-confirm" role="alertdialog" aria-label="Unsaved changes" data-testid="dialog-budget-unsaved">
          <span>You have unsaved plan edits. Switching to {budgetMonthLabel(pendingMonth)} will discard them.</span>
          <div className="bp-actions">
            <button className="button button-soft" onClick={() => setPendingMonth(null)} data-testid="button-budget-keep-editing">Keep editing</button>
            <button className="button button-danger" onClick={discardAndGo} data-testid="button-budget-discard">Discard and switch</button>
          </div>
        </div>
      )}

      {form ? (
        <FormProvider {...editor}><form className="surface bp-editor" onSubmit={editor.handleSubmit(() => submit())} noValidate data-testid="form-budget">
          <div className="bp-head">
            <h2>{editingId ? 'Edit' : 'New'} plan for {budgetMonthLabel(form.month)}</h2>
            <button type="button" className="icon-btn" onClick={() => { if (dirty && !window.confirm('Discard your unsaved edits?')) return; close(); }} aria-label="Close editor" data-testid="button-budget-close"><X size={17} /></button>
          </div>
          <div className="bp-grid">
            <div>
              <label className="field-label" htmlFor="bp-income">Expected take-home income</label>
              <input id="bp-income" className="field" inputMode="decimal" value={form.income} onChange={(e) => update({ income: e.target.value })} aria-invalid={showErrors && Boolean(errors.income)} data-testid="input-budget-income" />
              {err('income')}
            </div>
            <div>
              <label className="field-label" htmlFor="bp-savings">Savings target (planned set-aside)</label>
              <input id="bp-savings" className="field" inputMode="decimal" value={form.savings} onChange={(e) => update({ savings: e.target.value })} aria-invalid={showErrors && Boolean(errors.savings)} data-testid="input-budget-savings" />
              {err('savings')}
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor="bp-note">Plan note (optional, {form.note.length}/400)</label>
            <textarea id="bp-note" className="textarea" style={{ minHeight: 64 }} value={form.note} maxLength={400} onChange={(e) => update({ note: e.target.value })} data-testid="input-budget-note" />
            {err('note')}
          </div>
          <div>
            <div className="field-label">Category spending caps ({form.lines.length}/100)</div>
            <div className="bp-chips" aria-label="Category suggestions">
              {suggestions.filter((s) => !usedNames.has(normalizeCategory(s))).slice(0, 14).map((s) => (
                <button type="button" key={s} className="bp-chip" onClick={() => addLine(s)} disabled={form.lines.length >= 100} data-testid={`button-budget-suggest-${normalizeCategory(s).replace(/\s/g, '-')}`}>+ {s}</button>
              ))}
            </div>
          </div>
          {err('lines')}
          <div style={{ display: 'grid', gap: 8 }}>
            {form.lines.map((l, i) => (
              <div className="bp-cat" key={l.key} data-testid={`row-budget-edit-${i}`}>
                <div>
                  <label className="field-label" htmlFor={`bp-name-${l.key}`}>Category</label>
                  <input id={`bp-name-${l.key}`} className="field" list="bp-cat-list" value={l.category} maxLength={100} onChange={(e) => updateLine(l.key, { category: e.target.value })} aria-invalid={showErrors && Boolean(errors[`name-${l.key}`])} data-testid={`input-budget-category-${i}`} />
                  {err(`name-${l.key}`)}
                </div>
                <div>
                  <label className="field-label" htmlFor={`bp-amt-${l.key}`}>Monthly cap</label>
                  <input id={`bp-amt-${l.key}`} className="field" inputMode="decimal" value={l.amount} onChange={(e) => updateLine(l.key, { amount: e.target.value })} aria-invalid={showErrors && Boolean(errors[`amt-${l.key}`])} data-testid={`input-budget-amount-${i}`} />
                  {err(`amt-${l.key}`)}
                </div>
                <div>
                  <label className="field-label" htmlFor={`bp-cnote-${l.key}`}>Note (optional)</label>
                  <input id={`bp-cnote-${l.key}`} className="field" value={l.note} maxLength={160} onChange={(e) => updateLine(l.key, { note: e.target.value })} data-testid={`input-budget-category-note-${i}`} />
                  {err(`note-${l.key}`)}
                </div>
                <button type="button" className="icon-btn" style={{ marginTop: 22 }} onClick={() => update({ lines: form.lines.filter((x) => x.key !== l.key) })} aria-label={`Remove category ${l.category || i + 1}`} data-testid={`button-budget-remove-category-${i}`}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
          <datalist id="bp-cat-list">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
          <div><button type="button" className="button button-soft" onClick={() => addLine()} disabled={form.lines.length >= 100} data-testid="button-budget-add-category"><Plus size={14} /> Custom category</button></div>
          <div className={draftUnassigned < 0 ? 'bp-warn' : 'bp-note'} role="status" data-testid="text-budget-draft-unassigned">
            Planned expenses {formatMoney(draftAssigned)}. Unassigned after savings: {formatMoney(draftUnassigned)}.{draftUnassigned < 0 && ' The plan is over-allocated against expected income.'}
          </div>
          {failed && <div className="bp-warn" role="alert" data-testid="text-budget-save-error">Could not confirm this save. Your edits are kept. Review the save notice and refresh saved data before retrying; a plan may already have saved.</div>}
          <div className="form-actions" style={{ marginTop: 0 }}>
            <button type="button" className="button button-soft" onClick={() => { if (dirty && !window.confirm('Discard your unsaved edits?')) return; close(); }} data-testid="button-budget-cancel">Cancel</button>
            <button type="submit" className="button button-primary" disabled={busy} data-testid="button-budget-save">{busy ? 'Saving' : 'Save plan'}</button>
          </div>
        </form></FormProvider>
      ) : plan ? (
        <>
          <div className="bp-actions">
            <button className="button button-soft" onClick={() => open(toForm(plan, plan.month), plan.id)} data-testid="button-budget-edit"><Pencil size={14} /> Edit plan</button>
            <button className="button button-danger" onClick={() => { setDeleteFailed(false); setConfirmDelete(true); }} data-testid="button-budget-delete"><Trash2 size={14} /> Delete plan</button>
            <button className="button button-primary" onClick={() => onAddMoney(undefined, month)} data-testid="button-budget-log-money"><Plus size={14} /> Log money</button>
          </div>
          {confirmDelete && (
            <div className="bp-confirm" role="alertdialog" aria-label="Delete plan" data-testid="dialog-budget-delete">
              <span>Delete the {budgetMonthLabel(month)} plan? Your logged money notes stay as they are; only the plan is removed.</span>
              {deleteFailed && <div className="bp-warn" role="alert" data-testid="text-budget-delete-error">Could not confirm the deletion. Refresh saved data to check whether the plan is still there.</div>}
              <div className="bp-actions">
                <button className="button button-soft" onClick={() => setConfirmDelete(false)} data-testid="button-budget-delete-cancel">Keep plan</button>
                <button className="button button-danger" onClick={() => void remove()} disabled={busy} data-testid="button-budget-delete-confirm">Delete plan</button>
              </div>
            </div>
          )}
          <div className="bp-stats">
            <div className="surface bp-stat"><span>Expected income</span><b data-testid="text-budget-income-target">{formatMoney(incomeTarget)}</b><small data-testid="text-budget-logged-income">Logged {formatMoney(summary.income)}</small></div>
            <div className="surface bp-stat"><span>Planned expenses</span><b data-testid="text-budget-planned">{formatMoney(summary.plannedSpending)}</b><small data-testid="text-budget-logged-spending">Spent {formatMoney(summary.spending)}</small></div>
            <div className="surface bp-stat"><span>Savings target</span><b data-testid="text-budget-savings">{formatMoney(plan.savingsTarget)}</b><small>Planned set-aside</small></div>
            <div className="surface bp-stat"><span>Unassigned</span><b className={summary.unassigned < 0 ? 'bp-neg' : ''} data-testid="text-budget-unassigned">{formatMoney(summary.unassigned)}</b><small>Income - expenses - savings</small></div>
            <div className="surface bp-stat"><span>Caps left</span><b className={summary.remaining < 0 ? 'bp-neg' : 'bp-pos'} data-testid="text-budget-remaining">{formatMoney(summary.remaining)}</b><small>Planned minus all spending</small></div>
            <div className="surface bp-stat"><span>Net so far</span><b className={summary.net < 0 ? 'bp-neg' : ''} data-testid="text-budget-net">{formatMoney(summary.net)}</b><small>Left from logged income</small></div>
          </div>
          {summary.unassigned < 0 && <div className="bp-warn" role="alert" data-testid="warning-budget-overallocated">Over-allocated by {formatMoney(Math.abs(summary.unassigned))}: planned expenses plus savings exceed expected income.</div>}
          {plan.note && <div className="bp-note" data-testid="text-budget-plan-note">{plan.note}</div>}
          <div className="surface panel">
            <div className="panel-head"><h2>Categories</h2><span className="small-tag" data-testid="text-budget-entry-count">{summary.entryCount} notes logged</span></div>
            {summary.categories.length === 0 && <div className="task-sub" data-testid="text-budget-no-categories">No category caps in this plan yet.</div>}
            {summary.categories.map((c, i) => {
              const over = c.remaining < 0; const near = !over && c.percent >= 85;
              const cls = over ? 'over' : near ? 'near' : '';
              return (
                <div className="bp-line" key={`${c.category}-${i}`} data-testid={`row-budget-category-${i}`}>
                  <div className="bp-line-top">
                    <strong style={{ fontSize: 13 }}>{c.category}</strong>
                    <span className={`bp-status ${cls}`} data-testid={`status-budget-category-${i}`}>{over ? `Overspent by ${formatMoney(-c.remaining)}` : `${formatMoney(c.remaining)} remaining`}</span>
                  </div>
                  <div className="bp-bar" role="progressbar" aria-label={`${c.category} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(c.percent))}><div className={`bp-fill ${cls}`} style={{ width: '100%', transform: `scaleX(${Math.min(1, c.percent / 100)})` }} /></div>
                  <div className="bp-line-top">
                    <span className="list-meta" data-testid={`text-budget-category-spent-${i}`}>{formatMoney(c.spent)} of {formatMoney(c.amount)} ({Math.round(c.percent)}%)</span>
                    <button className="button button-plain" onClick={() => onAddMoney(c.category, month)} data-testid={`button-budget-log-category-${i}`}><Plus size={13} /> Log spending</button>
                  </div>
                  {c.note && <div className="list-meta">{c.note}</div>}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="surface panel" data-testid="empty-budget-plan">
          <div className="empty-state">
            <strong>No plan for {budgetMonthLabel(month)}</strong>
            <p>Set an income target, a savings target, and caps for the categories you care about.</p>
          </div>
          <div className="bp-actions" style={{ justifyContent: 'center' }}>
            <button className="button button-primary" onClick={() => open(toForm(undefined, month))} data-testid="button-budget-create"><Plus size={14} /> Create plan</button>
            {prevPlan && <button className="button button-soft" onClick={copyPrev} data-testid="button-budget-copy-previous"><Copy size={14} /> Copy {budgetMonthLabel(prevPlan.month)} as a start</button>}
            <button className="button button-soft" onClick={() => onAddMoney(undefined, month)} data-testid="button-budget-log-money-empty">Log money</button>
          </div>
        </div>
      )}

      {!form && (
        <div className="surface panel" data-testid="section-budget-unbudgeted">
          <div className="panel-head"><h2>{plan ? 'Spending without a cap' : 'Logged this month'}</h2></div>
          {!plan && <div className="list-meta" style={{ marginBottom: 8 }} data-testid="text-budget-unplanned-totals">Income {formatMoney(summary.income)}, spending {formatMoney(summary.spending)}, net {formatMoney(summary.net)}.</div>}
          {summary.unbudgeted.length === 0 ? <div className="task-sub" data-testid="text-budget-no-unbudgeted">{summary.spending ? 'All logged spending has a planned category.' : 'No spending notes have been logged for this month yet.'}</div> : summary.unbudgeted.map((u, i) => (
            <div className="bp-line" key={u.category} data-testid={`row-budget-unbudgeted-${i}`}>
              <div className="bp-line-top">
                <strong style={{ fontSize: 13 }}>{u.category || 'Uncategorized'}</strong>
                <span className="bp-status over" data-testid={`text-budget-unbudgeted-${i}`}>{formatMoney(u.spent)} with no cap</span>
              </div>
              <div><button className="button button-plain" onClick={() => onAddMoney(u.category, month)} data-testid={`button-budget-log-unbudgeted-${i}`}><Plus size={13} /> Log spending</button></div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default BudgetPlanner;
