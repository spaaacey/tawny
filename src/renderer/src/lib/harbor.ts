import type { HarborApi } from '../../../shared/harbor-api';

declare global {
  interface Window {
    harbor: HarborApi;
    harborChatMd: { render(md: string): string };
  }
}

export const H = window.harbor;
