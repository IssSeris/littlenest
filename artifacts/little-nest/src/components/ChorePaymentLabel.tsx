import { Coins } from 'lucide-react';
import type { NestChore } from '@workspace/api-client-react';
import { formatMoney } from '../lib/budget';

export default function ChorePaymentLabel({ chore }: { chore: NestChore }) {
  if (!chore.isPaid) return null;
  return <div className="list-meta" data-testid={`text-chore-payment-${chore.id}`}>
    <Coins size={12} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-2px', marginRight: 4 }} />
    Paid chore · {formatMoney(chore.payAmount)}{chore.allowanceRecorded ? ' · Allowance recorded for this due date' : ' on completion'}
  </div>;
}