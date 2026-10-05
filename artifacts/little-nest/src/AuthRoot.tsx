import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useCreateNestHousehold, useJoinNestHousehold } from '@workspace/api-client-react';
import './auth.css';

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#b96f80',
    colorForeground: '#403842',
    colorMutedForeground: '#6f6672',
    colorDanger: '#b4574a',
    colorBackground: '#fffef9',
    colorInput: '#fffefa',
    colorInputForeground: '#514650',
    colorNeutral: '#8a7b84',
    fontFamily: "'DM Sans', sans-serif",
    borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fffef9] rounded-3xl w-[440px] max-w-full overflow-hidden border border-[#efe0e3]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: { fontFamily: "'Fraunces', serif", fontWeight: 500, color: '#403842' },
    headerSubtitle: { color: '#6f6672' },
    socialButtonsBlockButtonText: { color: '#403842' },
    formFieldLabel: { color: '#5d525f', fontWeight: 700 },
    footerActionLink: { color: '#8f4f60', fontWeight: 700 },
    footerActionText: { color: '#6f6672' },
    dividerText: { color: '#6f6672' },
    identityPreviewEditButton: { color: '#8f4f60' },
    formFieldSuccessText: { color: '#4f7458' },
    alertText: { color: '#8f3f33' },
    logoImage: { borderRadius: '14px' },
    formButtonPrimary: { background: '#b96f80' },
  },
};

const queryClient = new QueryClient();

function Brand() {
  return (
    <Link href="/" className="auth-brand" data-testid="link-auth-brand">
      <img src={`${basePath}/logo.svg`} alt="" />
      <span>little nest</span>
    </Link>
  );
}

function Landing() {
  return (
    <div className="auth-page">
      <div className="auth-wide">
        <Brand />
        <div className="auth-hero">
          <div>
            <div className="eyebrow">Home, learning, and work, together</div>
            <h1>A little more room for real life.</h1>
            <p className="lead">One gentle place for chores, plans, school or work tasks, and a journal. Each person signs in privately, and nothing in a journal is shared unless its author chooses.</p>
            <div className="auth-cta">
              <Link href="/sign-up" className="button button-primary" data-testid="link-landing-signup">Create an account</Link>
              <Link href="/sign-in" className="button button-soft" data-testid="link-landing-signin">Sign in</Link>
            </div>
          </div>
          <ul className="auth-points">
            <li><strong>Separate sign-ins</strong>Each person has their own private account.</li>
            <li><strong>Journals stay yours</strong>Entries are private until you choose to share.</li>
            <li><strong>Join with a code</strong>Each household member joins with an invite assigned by a parent.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function Home() {
  return (
    <>
      <Show when="signed-in"><Redirect to="/app" /></Show>
      <Show when="signed-out"><Landing /></Show>
    </>
  );
}

function SignInPage() {
  return (
    <div className="auth-page">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}
function SignUpPage() {
  return (
    <div className="auth-page">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function Guard({ children }: { children: ReactNode }) {
  const { user } = useUser();
  return (
    <>
      <Show when="signed-in">
        <WouterRouter key={user?.id ?? 'signed-out'} base="/app">{children}</WouterRouter>
      </Show>
      <Show when="signed-out"><Redirect to="/" /></Show>
    </>
  );
}

function CacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prev = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    return addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prev.current !== undefined && prev.current !== userId) qc.clear();
      prev.current = userId;
    });
  }, [addListener, qc]);
  return null;
}

function ProviderWithRoutes({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to your little nest' } },
        signUp: { start: { title: 'Make your nest', subtitle: 'A private account, just for you' } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <CacheInvalidator />
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/app/*?"><Guard>{children}</Guard></Route>
          <Route><Redirect to="/" /></Route>
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function AuthRoot({ children }: { children: ReactNode }) {
  return (
    <WouterRouter base={basePath}>
      <ProviderWithRoutes>{children}</ProviderWithRoutes>
    </WouterRouter>
  );
}

export function HouseholdSetup({ onReady }: { onReady: () => void }) {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [parentName, setParentName] = useState('');
  const [childName, setChildName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const create = useCreateNestHousehold();
  const join = useJoinNestHousehold();
  const { signOut } = useClerk();
  const pending = create.isPending || join.isPending;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (mode === 'create') {
        await create.mutateAsync({ data: { name: name.trim(), parentName: parentName.trim(), childName: childName.trim() } });
      } else {
        await join.mutateAsync({ data: { code: code.trim() } });
      }
      onReady();
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : '';
      setError(mode === 'join' ? `That code did not work. Check it and try again.${msg ? ` (${msg})` : ''}` : `We could not create the household. Please try again.${msg ? ` (${msg})` : ''}`);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-wrap">
        <Brand />
        <div className="auth-card">
          <div className="eyebrow">One quick step</div>
          <h2>Set up your household</h2>
          <p className="note">Your account is ready. Start a household as a parent, or join as the role assigned to your invitation.</p>
          <div className="segmented auth-tabs" role="tablist">
            <button type="button" className={`segment ${mode === 'create' ? 'active' : ''}`} onClick={() => setMode('create')} data-testid="tab-setup-create">I am a parent</button>
            <button type="button" className={`segment ${mode === 'join' ? 'active' : ''}`} onClick={() => setMode('join')} data-testid="tab-setup-join">I have an invite code</button>
          </div>
          <form onSubmit={submit}>
            {mode === 'create' ? (
              <div className="settings-panel">
                <div><label className="field-label" htmlFor="hh-name">Household name</label><input id="hh-name" className="field" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="The Garden House" data-testid="input-household-name" /></div>
                <div><label className="field-label" htmlFor="hh-parent">Your name</label><input id="hh-parent" className="field" required maxLength={80} value={parentName} onChange={(e) => setParentName(e.target.value)} data-testid="input-parent-name" /></div>
                <div><label className="field-label" htmlFor="hh-child">Your child's name</label><input id="hh-child" className="field" required maxLength={80} value={childName} onChange={(e) => setChildName(e.target.value)} data-testid="input-child-name" /></div>
              </div>
            ) : (
              <div><label className="field-label" htmlFor="hh-code">Invite code</label><input id="hh-code" className="field" required minLength={32} maxLength={32} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} placeholder="32 characters from a parent" data-testid="input-invite-code" /></div>
            )}
            {error && <div className="auth-error" role="alert" data-testid="text-setup-error">{error}</div>}
            <div className="form-actions">
              <button className="button button-primary" type="submit" disabled={pending} data-testid="button-setup-submit">
                {pending ? 'Just a moment...' : mode === 'create' ? 'Create household' : 'Join household'}
              </button>
            </div>
          </form>
          <div className="privacy-note auth-fresh" data-testid="text-fresh-start-note">
            <strong>A fresh, secure start.</strong> A new household begins empty. Anything saved earlier in this browser, including journal drafts, is left untouched and is never imported automatically.
          </div>
          <button type="button" className="auth-link" onClick={() => signOut({ redirectUrl: basePath || '/' })} data-testid="button-setup-signout">Sign out</button>
        </div>
      </div>
    </div>
  );
}
