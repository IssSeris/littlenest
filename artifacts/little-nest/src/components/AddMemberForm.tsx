import React, { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { NestMember } from '@workspace/api-client-react';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from './ui/form';

const memberCreationSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(80, 'Use 80 characters or fewer.'),
  role: z.enum(['parent', 'child', 'householdMember']),
});
type MemberCreationValues = z.infer<typeof memberCreationSchema>;
const roleLabel = (role: MemberCreationValues['role']) => role === 'parent' ? 'Parent' : role === 'child' ? 'Child' : 'Household member';
const errorMessage = (error: unknown) => {
  const value = error as { data?: { error?: string }; message?: string };
  return value.data?.error ?? value.message ?? 'Could not add this profile. Please try again.';
};

export function AddMemberForm({
  onCreate,
  onSaved,
}: {
  onCreate: (values: MemberCreationValues) => Promise<NestMember>;
  onSaved: (member: NestMember) => Promise<void>;
}) {
  const form = useForm<MemberCreationValues>({
    resolver: zodResolver(memberCreationSchema),
    defaultValues: { name: '', role: 'child' },
  });
  const submitLock = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const submit = form.handleSubmit(async (values) => {
    if (submitLock.current) return;
    submitLock.current = true;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const created = await onCreate(values);
      await onSaved(created);
      form.reset({ name: '', role: 'child' });
      setSuccess(`${created.name} was added as a ${roleLabel(created.role)}. The saved household roster is up to date.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitLock.current = false;
      setSaving(false);
    }
  });
  const disabled = saving || form.formState.isSubmitting;

  return (
    <section className="add-member-panel" aria-labelledby="add-member-title">
      <div className="member-section-heading"><div><div className="eyebrow">Household profiles</div><h3 id="add-member-title">Add a member</h3></div></div>
      <Form {...form}>
        <form className="member-create-form" onSubmit={submit} noValidate>
          <div className="member-create-fields">
            <FormField control={form.control} name="name" render={({ field }) => <FormItem><FormLabel>Name</FormLabel><FormControl><input className="field" autoComplete="off" maxLength={80} placeholder="Enter a name" {...field} /></FormControl><FormMessage /></FormItem>} />
            <FormField control={form.control} name="role" render={({ field }) => <FormItem><FormLabel>Role</FormLabel><FormControl><select className="select" {...field}><option value="parent">Parent</option><option value="child">Child</option><option value="householdMember">Household member</option></select></FormControl><FormDescription>A Parent can manage household members and access household finances.</FormDescription><FormMessage /></FormItem>} />
          </div>
          <div className="form-actions"><button className="button button-primary" type="submit" disabled={disabled} data-testid="button-add-member">{saving ? 'Adding member…' : 'Add member'}</button></div>
          {saving && <p role="status">Saving this profile…</p>}
          {error && <p className="member-form-error" role="alert" data-testid="error-add-member">{error}</p>}
          {success && <p className="member-form-success" role="status" data-testid="success-add-member">{success}</p>}
        </form>
      </Form>
    </section>
  );
}