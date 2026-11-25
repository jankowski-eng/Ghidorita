/// <reference types="vite/client" />
interface Window {
  host: {
    getConfig(): Promise<{ port: number; autotest: string | null }>;
    pickFile(): Promise<string | null>;
    autotestDone(result: unknown): Promise<void>;
  };
}
