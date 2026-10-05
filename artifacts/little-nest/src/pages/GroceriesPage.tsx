import { useRef, useState, type FormEvent } from 'react';
import { Check, Heart, Pencil, Plus, ShoppingBasket, Trash2, X } from 'lucide-react';
import type { AppData } from '../App';
import type { DataSetter } from '../hooks/use-nest';
import PasteList from '../components/PasteList';
import type { ListSaver, ListRefresher } from '../lib/paste-list';
import './groceries.css';

const norm = (value: string) => value.trim().toLowerCase();

export default function GroceriesPage({ data, setData, onSaveList, onRefreshList }: { data: AppData; setData: DataSetter; onSaveList: ListSaver; onRefreshList: ListRefresher }) {
  const [title, setTitle] = useState('');
  const [quantity, setQuantity] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const titleInput = useRef<HTMLInputElement>(null);
  const groceries = data.groceries;
  const favorites = data.groceryFavorites;
  const remaining = groceries.filter((item) => !item.done).length;

  const reset = () => { setTitle(''); setQuantity(''); setEditingId(null); setFormError(''); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    const cleanQty = quantity.trim();
    if (!cleanTitle) return setFormError('Add an item name.');
    if (cleanTitle.length > 300) return setFormError('Item names can be up to 300 characters.');
    if (cleanQty.length > 100) return setFormError('Quantity can be up to 100 characters.');
    setFormError('');
    if (editingId) {
      if (!groceries.some((item) => item.id === editingId)) return setFormError('This item was removed from the list. Cancel to start again.');
      const ok = await setData((old) => ({ ...old, groceries: old.groceries.map((item) => item.id === editingId ? { ...item, title: cleanTitle, quantity: cleanQty } : item) }));
      if (ok) reset();
    } else {
      const ok = await setData((old) => ({ ...old, groceries: [...old.groceries, { id: crypto.randomUUID(), title: cleanTitle, quantity: cleanQty, done: false }] }));
      if (ok) reset();
    }
  };

  const startEdit = (id: string) => {
    const item = groceries.find((row) => row.id === id);
    if (!item) return;
    setEditingId(id); setTitle(item.title); setQuantity(item.quantity); setFormError('');
    titleInput.current?.focus();
  };
  const toggle = (id: string) => { void setData((old) => ({ ...old, groceries: old.groceries.map((item) => item.id === id ? { ...item, done: !item.done } : item) })); };
  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Remove "${name}" from the list? Saved favorites stay.`)) return;
    const deleted = await setData((old) => ({ ...old, groceries: old.groceries.filter((item) => item.id !== id) }));
    if (deleted && editingId === id) reset();
  };
  const saveFavorite = (id: string) => {
    const item = groceries.find((row) => row.id === id);
    if (!item) return;
    void setData((old) => old.groceryFavorites.some((fav) => norm(fav.title) === norm(item.title)) ? old : ({ ...old, groceryFavorites: [...old.groceryFavorites, { id: crypto.randomUUID(), title: item.title.trim(), quantity: item.quantity }] }));
  };
  const addFavorite = (id: string) => {
    const fav = favorites.find((row) => row.id === id);
    if (!fav) return;
    void setData((old) => old.groceries.some((item) => !item.done && norm(item.title) === norm(fav.title)) ? old : ({ ...old, groceries: [...old.groceries, { id: crypto.randomUUID(), title: fav.title, quantity: fav.quantity, done: false }] }));
  };
  const removeFavorite = (id: string, name: string) => {
    if (!window.confirm(`Remove "${name}" from saved favorites? Your list is unchanged.`)) return;
    void setData((old) => ({ ...old, groceryFavorites: old.groceryFavorites.filter((fav) => fav.id !== id) }));
  };

  return (
    <div className="groceries-page" data-testid="page-groceries">
      <div className="page-head">
        <div className="page-head-copy">
          <div className="eyebrow">Shared with the household</div>
          <h1>Groceries</h1>
          <p className="lead">One list you both can add to and check off, plus favorites you buy again and again.</p>
        </div>
      </div>

      <form className="surface section-panel grocery-form" onSubmit={submit} data-testid="form-grocery">
        <div className="grocery-form-fields">
          <div className="grocery-field-title">
            <label className="field-label" htmlFor="grocery-title">{editingId ? 'Edit item' : 'Add an item'}</label>
            <input ref={titleInput} id="grocery-title" className="field" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder="Oat milk" data-testid="input-grocery-title" />
          </div>
          <div className="grocery-field-qty">
            <label className="field-label" htmlFor="grocery-qty">Quantity (optional)</label>
            <input id="grocery-qty" className="field" value={quantity} maxLength={100} onChange={(e) => setQuantity(e.target.value)} placeholder="2 cartons" data-testid="input-grocery-quantity" />
          </div>
          <div className="grocery-form-actions">
            <button type="submit" className="button button-primary" data-testid="button-save-grocery">{editingId ? <><Check size={15} /> Save</> : <><Plus size={15} /> Add</>}</button>
            {editingId && <button type="button" className="button button-soft" onClick={reset} data-testid="button-cancel-grocery">Cancel</button>}
          </div>
        </div>
        {formError && <p className="grocery-error" role="alert" data-testid="text-grocery-error">{formError}</p>}
      </form>
      <PasteList kind="groceries" data={data} onSave={onSaveList} onRefresh={onRefreshList} />

      <div className="section-grid grocery-grid">
        <section className="surface section-panel" aria-labelledby="grocery-list-heading">
          <div className="panel-head"><h2 id="grocery-list-heading">Shopping list</h2><span className="small-tag" data-testid="text-grocery-remaining">{remaining} to buy</span></div>
          {groceries.length ? groceries.map((item) => {
            const saved = favorites.some((fav) => norm(fav.title) === norm(item.title));
            return (
              <div className={`list-item grocery-row ${item.done ? 'grocery-done' : ''}`} key={item.id} data-testid={`row-grocery-${item.id}`}>
                <button type="button" className={`check ${item.done ? 'checked' : ''}`} onClick={() => toggle(item.id)} aria-pressed={item.done} aria-label={item.done ? `Mark ${item.title} not bought` : `Mark ${item.title} bought`} data-testid={`button-toggle-grocery-${item.id}`}>{item.done && <Check size={13} />}</button>
                <div className="list-info">
                  <div className="list-title grocery-title" data-testid={`text-grocery-title-${item.id}`}>{item.title}</div>
                  {item.quantity && <div className="list-meta" data-testid={`text-grocery-quantity-${item.id}`}>{item.quantity}</div>}
                </div>
                <div className="grocery-controls">
                  <button type="button" className={`icon-btn ${saved ? 'grocery-fav-on' : ''}`} disabled={saved} onClick={() => saveFavorite(item.id)} aria-label={saved ? `${item.title} is a saved favorite` : `Save ${item.title} as favorite`} title={saved ? 'Already a favorite' : 'Save as favorite'} data-testid={`button-favorite-grocery-${item.id}`}><Heart size={15} fill={saved ? 'currentColor' : 'none'} /></button>
                  <button type="button" className="icon-btn" onClick={() => startEdit(item.id)} aria-label={`Edit ${item.title}`} data-testid={`button-edit-grocery-${item.id}`}><Pencil size={15} /></button>
                  <button type="button" className="icon-btn" onClick={() => remove(item.id, item.title)} aria-label={`Delete ${item.title}`} data-testid={`button-delete-grocery-${item.id}`}><Trash2 size={15} /></button>
                </div>
              </div>
            );
          }) : <div className="empty-state" data-testid="empty-groceries"><div className="empty-symbol"><ShoppingBasket size={20} /></div><strong>The list is clear</strong><p>Add what you need above, or pull in a saved favorite.</p></div>}
        </section>

        <section className="surface section-panel" aria-labelledby="grocery-fav-heading">
          <div className="panel-head"><h2 id="grocery-fav-heading">Saved favorites</h2><span className="small-tag child" data-testid="text-favorites-count">{favorites.length} saved</span></div>
          {favorites.length ? favorites.map((fav) => {
            const onList = groceries.some((item) => !item.done && norm(item.title) === norm(fav.title));
            return (
              <div className="list-item grocery-row" key={fav.id} data-testid={`row-favorite-${fav.id}`}>
                <div className="list-info">
                  <div className="list-title" data-testid={`text-favorite-title-${fav.id}`}>{fav.title}</div>
                  {fav.quantity && <div className="list-meta">{fav.quantity}</div>}
                </div>
                <div className="grocery-controls">
                  <button type="button" className="button button-soft grocery-add-fav" disabled={onList} onClick={() => addFavorite(fav.id)} aria-label={onList ? `${fav.title} is already on the list` : `Add ${fav.title} to the list`} data-testid={`button-add-favorite-${fav.id}`}>{onList ? <><Check size={13} /> On list</> : <><Plus size={13} /> Add</>}</button>
                  <button type="button" className="icon-btn" onClick={() => removeFavorite(fav.id, fav.title)} aria-label={`Remove ${fav.title} from favorites`} data-testid={`button-remove-favorite-${fav.id}`}><X size={15} /></button>
                </div>
              </div>
            );
          }) : <div className="empty-state" data-testid="empty-favorites"><div className="empty-symbol"><Heart size={20} /></div><strong>No favorites yet</strong><p>Tap the heart on any list item to keep it for next time.</p></div>}
        </section>
      </div>
    </div>
  );
}
