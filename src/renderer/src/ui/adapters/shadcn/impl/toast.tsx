import { toast } from 'sonner';
import type { ToastApi } from '../../../contract/toast';
import { Toaster as ShadcnToaster } from '../sonner';

// className drops the generated "group" class, which collides with legacy .group (overflow:hidden).
// Map sonner's vars to the app theme tokens (shadcn's --popover etc. are not defined as :root vars here).
const STYLE = {
  '--normal-bg': 'var(--panel)',
  '--normal-text': 'var(--text)',
  '--normal-border': 'var(--line-2)',
  '--border-radius': '8px',
} as React.CSSProperties;

export const Toaster: ToastApi['Toaster'] = () => (
  <ShadcnToaster className="toaster" position="bottom-right" offset={{ right: 16, bottom: 40 }} style={STYLE} />
);

export const showToast: ToastApi['showToast'] = (msg, ms = 4000) => {
  toast(msg, { duration: ms });
};
