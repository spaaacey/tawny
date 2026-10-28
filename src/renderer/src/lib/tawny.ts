import type { TawnyApi } from '../../../shared/tawny-api';

declare global {
  interface Window {
    tawny: TawnyApi;
    tawnyChatMd: { render(md: string): string };
  }
}

export const H = window.tawny;
