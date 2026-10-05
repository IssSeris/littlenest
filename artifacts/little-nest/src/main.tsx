import { createRoot } from 'react-dom/client';
import { useUser } from '@clerk/react';

import App from './App';
import AuthRoot from './AuthRoot';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

function AccountApp() {
  const { user } = useUser();
  return <App key={user?.id ?? 'signed-out'} />;
}

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <AuthRoot><AccountApp /></AuthRoot>
  </ErrorBoundary>,
);
