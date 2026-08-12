/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* shadcn CSS variable colors */
        foreground: 'var(--foreground)',
        card: { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
        popover: { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)' },
        ring: 'var(--ring)',
        /* Project static colors */
        background: "#050507",
        surface: {
          DEFAULT: "#0f0f13",
          lighter: "#1e1e28",
          mid: "#16161d",
          darker: "#0a0a0e",
        },
        primary: {
          DEFAULT: "#0a81d9",
          light: "#3d9ee6",
          dark: "#0768b3",
          glow: "rgba(10, 129, 217, 0.5)",
        },
        accent: {
          DEFAULT: "#9850c3",
          light: "#b374d9",
          dark: "#7c3aad",
          pink: "#e6428d",
          purple: "#9850c3",
          indigo: "#675add",
        },
        brand: {
          gold: "#f7bc59",
          pink: "#e6428d",
          purple: "#9850c3",
          indigo: "#675add",
          blue: "#0a81d9",
          teal: "#02c5bf",
        },
        success: "#10b981",
        warning: "#f7bc59",
        error: "#ef4444",
        border: {
          DEFAULT: "rgba(255, 255, 255, 0.04)",
          light: "rgba(255, 255, 255, 0.07)",
          hover: "rgba(255, 255, 255, 0.12)",
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Plus Jakarta Sans', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-mesh': 'radial-gradient(at 0% 0%, rgba(10, 129, 217, 0.12) 0, transparent 50%), radial-gradient(at 100% 0%, rgba(152, 80, 195, 0.10) 0, transparent 50%), radial-gradient(at 100% 100%, rgba(103, 90, 221, 0.08) 0, transparent 50%), radial-gradient(at 0% 100%, rgba(2, 197, 191, 0.06) 0, transparent 50%)',
        'gradient-accent': 'linear-gradient(135deg, #e6428d, #9850c3)',
        'gradient-brand': 'linear-gradient(135deg, #e6428d, #9850c3, #675add, #0a81d9)',
        'gradient-brand-full': 'linear-gradient(135deg, #f7bc59, #e6428d, #9850c3, #675add, #0a81d9, #02c5bf)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'float': 'float 6s ease-in-out infinite',
        'scan-line': 'scan 2.5s linear infinite',
        'shimmer': 'shimmer 2s linear infinite',
        'gradient-shift': 'gradient-shift 8s ease infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'gradient-shift': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
      },
      boxShadow: {
        'glow-primary': '0 0 20px -5px rgba(10, 129, 217, 0.5)',
        'glow-accent': '0 0 20px -5px rgba(152, 80, 195, 0.5)',
        'glow-pink': '0 0 20px -5px rgba(230, 66, 141, 0.4)',
        'glass': 'inset 0 1px 1px 0 rgba(255, 255, 255, 0.05)',
        'elevated': '0 8px 32px -8px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.03)',
      },
    },
  },
  plugins: [],
}
