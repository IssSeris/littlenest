import type { AppData } from '../App';

export type ListKind = 'groceries' | 'chores';
export type ListDraft = {
  id: string; title: string; quantity: string; assignedTo: string; cadence: string; dueDate: string;
  isPaid?: boolean; payAmount?: string;
};
export type ListSaveResult = { status: 'saved' | 'uncertain' | 'blocked'; error?: string };
export type ListSaver = (kind: ListKind, row: ListDraft) => Promise<ListSaveResult>;
export type ListRefresher = () => Promise<AppData | null>;
export const cadences = ['Once', 'Daily', 'Weekdays', 'Weekly'] as const;

export function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Strip only recognizable leading list markers, never commas or embedded quantities. */
export function parseList(input: string): string[] {
  return input.split(/\r\n|\n|\r/).map((line) => {
    let title = line.trim();
    // Allow stacked prefixes, e.g. "- [x] Milk" or "1. [ ] Dishes".
    for (;;) {
      const next = title.replace(/^(?:[-*+•●◦▪‣–—](?:\s+|$)|\d+[.)](?:\s+|$)|\(\d+\)(?:\s+|$)|\[[ xX✓✔]?\](?:\s+|$)|[☐☑☒](?:\s*))/u, '').trim();
      if (next === title) break;
      title = next;
    }
    return title;
  }).filter(Boolean);
}

export function validateDraft(kind: ListKind, row: ListDraft, members: AppData['members']): string[] {
  const errors: string[] = [];
  if (!row.title.trim()) errors.push('Add an item name.');
  if (row.title.trim().length > 300) errors.push('Item names can be up to 300 characters.');
  if (/[\r\n]/.test(row.title)) errors.push('Keep each item name on one line.');
  if (kind === 'groceries') {
    if (row.quantity.trim().length > 100) errors.push('Quantity can be up to 100 characters.');
  } else {
    if (row.assignedTo !== 'household' && !members.some((member) => member.id === row.assignedTo)) errors.push('Choose a household member or Household.');
    if (row.isPaid) {
      const amount = Number(row.payAmount);
      if (!/^(?:\d+|\d*\.\d{1,2})$/.test((row.payAmount ?? '').trim()) || !Number.isFinite(amount) || amount < 0.01 || amount > 10000000) errors.push('Paid chores need an amount from 0.01 to 10,000,000, with up to two decimal places.');
    }
    if (!(cadences as readonly string[]).includes(row.cadence)) errors.push('Choose a valid cadence.');
    const date = new Date(`${row.dueDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== row.dueDate) errors.push('Choose a valid due date.');
  }
  return errors;
}

export function draftPayload(kind: ListKind, row: ListDraft) {
  return kind === 'groceries'
    ? { title: row.title.trim(), quantity: row.quantity.trim(), done: false }
    : { title: row.title.trim(), assignedTo: row.assignedTo, cadence: row.cadence, dueDate: row.dueDate, done: false, isPaid: row.isPaid ?? false, payAmount: row.isPaid ? Number(row.payAmount) : 0 };
}