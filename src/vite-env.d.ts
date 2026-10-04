/// <reference types="vite/client" />

declare module '*.css';

type CleanupCallback = () => void;

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => {
  detect(source: CanvasImageSource | Blob | ImageData): Promise<Array<{ rawValue: string }>>;
};

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    __storyViewerKey?: ((event: KeyboardEvent) => void) | null;
    __SEEDING_IN_PROGRESS?: boolean;
    __shownIncomingCallId?: string | null;
    BarcodeDetector?: BarcodeDetectorConstructor;
  }

  const BarcodeDetector: BarcodeDetectorConstructor;
}

export {};
