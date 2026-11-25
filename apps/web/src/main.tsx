import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { router } from './router';
import { applyTheme, useTheme } from './lib/theme';
import './index.css';

// Before the first paint, on every page (editor, login and public form included).
applyTheme();

function ThemedToaster() {
  const { isDark } = useTheme();
  return <Toaster richColors position="top-right" theme={isDark ? 'dark' : 'light'} />;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
        <ThemedToaster />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
