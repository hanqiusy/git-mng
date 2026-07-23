import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tauri：clearScreen/envPrefix 避免盖住 cargo 日志。业务经 invoke，无需 /api 代理。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  server: {
    strictPort: true,
    host: '127.0.0.1',
  },
});
