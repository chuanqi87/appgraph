/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/webui/client/**/*.{ts,html}'],
  theme: {
    extend: {
      colors: {
        sidebar: {
          bg: '#191b1f',
          surface: '#24262b',
          border: '#2a2d33',
          fg: '#e6e6e6',
          muted: '#9aa0a6',
        },
        panel: {
          bg: '#ffffff',
          border: '#e2e4e8',
          alt: '#f7f8fa',
        },
        detail: {
          bg: '#24262b',
          border: '#33363d',
          fg: '#e6e6e6',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['SFMono-Regular', 'Consolas', 'Liberation Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
