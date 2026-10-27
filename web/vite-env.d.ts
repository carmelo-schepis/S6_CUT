/// <reference types="vite/client" />

declare module "*.png" {
  const src: string;
  export default src;
}

declare const __S6_PWA_ENABLED__: boolean;
