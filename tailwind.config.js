/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "SF Pro Display", "system-ui", "sans-serif"],
      },
      keyframes: {
        // Directional git-op loading cues: the icon "pulls" downward / "pushes"
        // upward on a loop while the op runs.
        "bounce-down": {
          "0%, 100%": { transform: "translateY(-1px)" },
          "50%": { transform: "translateY(2px)" },
        },
        "bounce-up": {
          "0%, 100%": { transform: "translateY(1px)" },
          "50%": { transform: "translateY(-2px)" },
        },
        // Marquee for overflowing branch names: slide left by exactly the
        // overflow amount, pause at each end. Distance is set per-instance via
        // the `--marquee-shift` CSS var.
        "marquee-hover": {
          "0%, 15%": { transform: "translateX(0)" },
          "85%, 100%": { transform: "translateX(var(--marquee-shift, 0))" },
        },
      },
      animation: {
        "bounce-down": "bounce-down 0.7s ease-in-out infinite",
        "bounce-up": "bounce-up 0.7s ease-in-out infinite",
        "marquee-hover": "marquee-hover 6s ease-in-out infinite alternate",
      },
    },
  },
  plugins: [],
}

