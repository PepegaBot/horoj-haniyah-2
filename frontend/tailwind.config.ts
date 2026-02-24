import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        card: "var(--card)",
        neonBlue: "var(--neon-blue)",
        neonPurple: "var(--neon-purple)",
        neonPink: "var(--neon-pink)",
      },
      boxShadow: {
        glowBlue: "0 0 24px rgba(66, 194, 255, 0.45)",
        glowPurple: "0 0 28px rgba(144, 90, 255, 0.45)",
      },
      keyframes: {
        pulseNeon: {
          "0%, 100%": { transform: "scale(1)", filter: "drop-shadow(0 0 0px rgba(255,255,255,0.5))" },
          "50%": { transform: "scale(1.06)", filter: "drop-shadow(0 0 16px rgba(255,255,255,0.85))" },
        },
      },
      animation: {
        pulseNeon: "pulseNeon 1.3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
