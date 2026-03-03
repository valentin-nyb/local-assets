/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./*.html', './*.js'],
  theme: {
    extend: {
      colors: {
        background: '#050505',
        foreground: '#ffffff',
        card: '#0a0a0a',
        border: '#27272a',
        muted: { DEFAULT: '#27272a', foreground: '#a1a1aa' },
        primary: { DEFAULT: '#39FF14', foreground: '#000000', glow: 'rgba(57, 255, 20, 0.5)' },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      backgroundImage: {
        noise: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E\")",
      },
      animation: {
        scroll: 'scroll 30s linear infinite',
      },
      keyframes: {
        scroll: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
    },
  },
  plugins: [],
};
