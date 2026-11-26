/// <reference types="vite/client" />
interface Window {
  host: import("../preload/index").Host;
}
