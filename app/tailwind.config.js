/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        pitch: "#07120c",
        card: "#0d1f14",
        line: "#1c3526",
        grass: "#22c55e",
        gold: "#eab308",
      },
    },
  },
  plugins: [],
};
