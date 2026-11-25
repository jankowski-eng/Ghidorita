/// <reference types="vite/client" />
interface Window {
  host: {
    getConfig(): Promise<{ port: number; token: string; autotest: string | null; bench: boolean }>;
    pickFile(): Promise<string | null>;
    autotestDone(result: unknown): Promise<void>;
  };
}
