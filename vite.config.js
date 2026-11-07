import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Actions がリポジトリ名を自動取得するため、手入力不要。
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
export default defineConfig({
  plugins: [react()],
  base: repo ? `/${repo}/` : '/',
});
