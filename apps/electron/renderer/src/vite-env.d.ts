/// <reference types="vite/client" />

import type { LighteeApi } from "../../../shared/ipc-contract";

declare global {
  interface Window {
    lightee?: LighteeApi;
  }
}

export {};
